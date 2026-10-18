import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { testContext, seedUser } from './helpers.js';
import { createApiKey } from '../src/lib/keys.js';

let ctx;
let admin;
let viewer;

beforeEach(async () => {
  ctx = await testContext();
  admin = await seedUser(ctx.pool, { email: 'admin@example.com', password: 'adminpw', role: 'admin' });
  viewer = await seedUser(ctx.pool, { email: 'viewer@example.com', password: 'viewerpw', role: 'viewer' });
});

async function loginAs(email, password) {
  const res = await request(ctx.app).post('/api/auth/login').send({ email, password });
  return res;
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

describe('POST /api/auth/login', () => {
  it('logs in with valid credentials, sets an httpOnly cookie, returns token', async () => {
    const res = await loginAs('admin@example.com', 'adminpw');
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('admin@example.com');
    expect(res.body.user.role).toBe('admin');
    expect(res.body.user).not.toHaveProperty('password_hash');
    expect(typeof res.body.token).toBe('string');
    const cookie = res.headers['set-cookie']?.join(';') || '';
    expect(cookie).toContain('tt_session=');
    expect(cookie).toMatch(/httponly/i);
  });

  it('rejects wrong password with 401', async () => {
    const res = await loginAs('admin@example.com', 'nope');
    expect(res.status).toBe(401);
  });

  it('rejects unknown email with 401 (no user enumeration detail)', async () => {
    const res = await loginAs('nobody@example.com', 'whatever');
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid email or password');
  });

  it('requires both fields', async () => {
    const res = await request(ctx.app).post('/api/auth/login').send({ email: 'a@b.c' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/auth/me + logout', () => {
  it('returns the current user for a valid token', async () => {
    const login = await loginAs('viewer@example.com', 'viewerpw');
    const res = await request(ctx.app).get('/api/auth/me').set(authHeader(login.body.token));
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: 'viewer@example.com', role: 'viewer' });
  });

  it('401s without a token', async () => {
    const res = await request(ctx.app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('401s on a tampered token', async () => {
    const res = await request(ctx.app)
      .get('/api/auth/me')
      .set(authHeader('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.tampered'));
    expect(res.status).toBe(401);
  });

  it('clears the cookie on logout', async () => {
    const res = await request(ctx.app).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']?.join(';')).toMatch(/Max-Age=0/);
  });
});

describe('API keys management + RBAC', () => {
  it('admin can issue a key; plaintext shown once', async () => {
    const login = await loginAs('admin@example.com', 'adminpw');
    const res = await request(ctx.app)
      .post('/api/keys')
      .set(authHeader(login.body.token))
      .send({ name: 'acme', monthlyQuotaTokens: 5000, rateLimitPerMin: 30 });
    expect(res.status).toBe(201);
    expect(res.body.data.key).toMatch(/^tt_live_/);
    expect(res.body.data.name).toBe('acme');
    expect(res.body.data.monthly_quota_tokens).toBe(5000);
    // Never stored in plaintext: only the hash is in the DB.
    const { rows } = await ctx.pool.query('SELECT key_hash FROM api_keys');
    expect(rows[0].key_hash).toHaveLength(64);
  });

  it('viewer cannot issue a key (403)', async () => {
    const login = await loginAs('viewer@example.com', 'viewerpw');
    const res = await request(ctx.app)
      .post('/api/keys')
      .set(authHeader(login.body.token))
      .send({ name: 'nope' });
    expect(res.status).toBe(403);
  });

  it('viewer CAN list keys (read-only role)', async () => {
    const login = await loginAs('viewer@example.com', 'viewerpw');
    const res = await request(ctx.app).get('/api/keys').set(authHeader(login.body.token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('unauthenticated key listing is 401', async () => {
    const res = await request(ctx.app).get('/api/keys');
    expect(res.status).toBe(401);
  });

  it('admin can update quota config; viewer gets 403', async () => {
    const key = await createApiKey(ctx.pool, { name: 'k', userId: admin.id });
    const adminLogin = await loginAs('admin@example.com', 'adminpw');
    const ok = await request(ctx.app)
      .patch(`/api/keys/${key.id}`)
      .set(authHeader(adminLogin.body.token))
      .send({ monthlyQuotaTokens: 12345 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.monthly_quota_tokens).toBe(12345);

    const viewerLogin = await loginAs('viewer@example.com', 'viewerpw');
    const denied = await request(ctx.app)
      .patch(`/api/keys/${key.id}`)
      .set(authHeader(viewerLogin.body.token))
      .send({ monthlyQuotaTokens: 1 });
    expect(denied.status).toBe(403);
  });

  it('admin can revoke; viewer gets 403; double revoke is 404', async () => {
    const key = await createApiKey(ctx.pool, { name: 'k', userId: admin.id });
    const viewerLogin = await loginAs('viewer@example.com', 'viewerpw');
    const denied = await request(ctx.app)
      .post(`/api/keys/${key.id}/revoke`)
      .set(authHeader(viewerLogin.body.token));
    expect(denied.status).toBe(403);

    const adminLogin = await loginAs('admin@example.com', 'adminpw');
    const ok = await request(ctx.app)
      .post(`/api/keys/${key.id}/revoke`)
      .set(authHeader(adminLogin.body.token));
    expect(ok.status).toBe(200);
    const again = await request(ctx.app)
      .post(`/api/keys/${key.id}/revoke`)
      .set(authHeader(adminLogin.body.token));
    expect(again.status).toBe(404);
  });

  it('issued keys work against the proxy', async () => {
    const adminLogin = await loginAs('admin@example.com', 'adminpw');
    const issued = await request(ctx.app)
      .post('/api/keys')
      .set(authHeader(adminLogin.body.token))
      .send({ name: 'proxy-check' });
    const proxied = await request(ctx.app)
      .post('/v1/proxy/chat/completions')
      .set('x-api-key', issued.body.data.key)
      .send({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(proxied.status).toBe(200);
  });
});

describe('GET /api/stats/overview + /api/stats/daily', () => {
  async function seedUsage() {
    const key = await createApiKey(ctx.pool, { name: 'stats-key', userId: admin.id });
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    await ctx.pool.query(
      `INSERT INTO usage_events (key_id, model, prompt_tokens, completion_tokens, total_tokens, created_at)
       VALUES ($1, 'm', 100, 50, 150, $2), ($1, 'm', 200, 100, 300, $3)`,
      [key.id, now.toISOString(), yesterday.toISOString()]
    );
    return key;
  }

  it('overview aggregates today/month and top keys', async () => {
    await seedUsage();
    const login = await loginAs('viewer@example.com', 'viewerpw');
    const res = await request(ctx.app).get('/api/stats/overview').set(authHeader(login.body.token));
    expect(res.status).toBe(200);
    expect(res.body.today.tokens).toBe(150);
    expect(res.body.today.requests).toBe(1);
    expect(res.body.month.tokens).toBe(450);
    expect(res.body.month.requests).toBe(2);
    expect(res.body.topKeys).toHaveLength(1);
    expect(res.body.topKeys[0]).toMatchObject({ name: 'stats-key', tokens: 450, requests: 2 });
  });

  it('daily buckets per-day totals, zero-filled', async () => {
    await seedUsage();
    const login = await loginAs('admin@example.com', 'adminpw');
    const res = await request(ctx.app)
      .get('/api/stats/daily?days=3')
      .set(authHeader(login.body.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    const today = res.body.data[2];
    expect(today.tokens).toBe(150);
    expect(today.requests).toBe(1);
    expect(res.body.data[1].tokens).toBe(300);
    expect(res.body.data[0].tokens).toBe(0);
  });

  it('stats require auth', async () => {
    const res = await request(ctx.app).get('/api/stats/overview');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/billing/summary', () => {
  it('computes plan usage vs included tokens and overage estimate', async () => {
    const key = await createApiKey(ctx.pool, { name: 'bill-key', userId: admin.id });
    await ctx.pool.query(
      `INSERT INTO usage_events (key_id, model, prompt_tokens, completion_tokens, total_tokens)
       VALUES ($1, 'm', 0, 0, 2500000)`,
      [key.id]
    );
    const login = await loginAs('admin@example.com', 'adminpw');
    const res = await request(ctx.app).get('/api/billing/summary').set(authHeader(login.body.token));
    expect(res.status).toBe(200);
    // Default seeded plan: starter, $19, 1M included, $0.002/1K overage.
    expect(res.body.plan).toMatchObject({ name: 'starter', price_cents: 1900, included_tokens: 1000000 });
    expect(res.body.period.used_tokens).toBe(2500000);
    expect(res.body.period.overage_tokens).toBe(1500000);
    // 1500000/1000 * 20c = 30000c = $300.
    expect(res.body.period.overage_estimate_cents).toBe(30000);
    expect(res.body.stripe).toBeNull();
  });

  it('zero overage when under the included tokens', async () => {
    const login = await loginAs('viewer@example.com', 'viewerpw');
    const res = await request(ctx.app).get('/api/billing/summary').set(authHeader(login.body.token));
    expect(res.status).toBe(200);
    expect(res.body.period.overage_tokens).toBe(0);
    expect(res.body.period.overage_estimate_cents).toBe(0);
  });
});
