import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { testContext, seedUser } from './helpers.js';
import { createApiKey } from '../src/lib/keys.js';

async function insertAudit(pool, { keyId, model, text, createdAt }) {
  await pool.query(
    `INSERT INTO audit_logs (key_id, model, request_redacted, response_redacted, created_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)`,
    [
      keyId,
      model,
      JSON.stringify({ messages: [{ content: text }] }),
      JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      createdAt,
    ]
  );
}

describe('GET /api/audit', () => {
  let ctx;
  let keyA;
  let keyB;
  let token;
  beforeEach(async () => {
    ctx = await testContext({ mockUpstream: 'true' });
    const user = await seedUser(ctx.pool);
    const login = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: user.email, password: user.password });
    token = login.body.token;
    keyA = await createApiKey(ctx.pool, { name: 'a', userId: user.id });
    keyB = await createApiKey(ctx.pool, { name: 'b', userId: user.id });
    await insertAudit(ctx.pool, {
      keyId: keyA.id,
      model: 'mock-model',
      text: 'summarize the quarterly report',
      createdAt: '2026-10-10T10:00:00Z',
    });
    await insertAudit(ctx.pool, {
      keyId: keyA.id,
      model: 'other-model',
      text: 'translate hello to french',
      createdAt: '2026-10-12T10:00:00Z',
    });
    await insertAudit(ctx.pool, {
      keyId: keyB.id,
      model: 'mock-model',
      text: 'draft an email about the launch',
      createdAt: '2026-10-14T10:00:00Z',
    });
  });
  afterEach(async () => {
    await ctx.pool.end();
  });

  const authed = (req) => req.set('Authorization', `Bearer ${token}`);

  it('returns all rows newest-first with a total', async () => {
    const res = await authed(request(ctx.app).get('/api/audit')).expect(200);
    expect(res.body.total).toBe(3);
    expect(res.body.data).toHaveLength(3);
    const dates = res.body.data.map((r) => r.created_at);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('rejects unauthenticated access', async () => {
    await request(ctx.app).get('/api/audit').expect(401);
  });

  it('filters by key_id', async () => {
    const res = await authed(request(ctx.app).get(`/api/audit?key_id=${keyA.id}`)).expect(200);
    expect(res.body.total).toBe(2);
    expect(res.body.data.every((r) => r.key_id === keyA.id)).toBe(true);
  });

  it('rejects a non-integer key_id', async () => {
    await authed(request(ctx.app).get('/api/audit?key_id=abc')).expect(400);
  });

  it('filters by model', async () => {
    const res = await authed(request(ctx.app).get('/api/audit?model=other-model')).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].model).toBe('other-model');
  });

  it('filters by date range', async () => {
    const res = await authed(
      request(ctx.app).get('/api/audit?from=2026-10-11T00:00:00Z&to=2026-10-13T00:00:00Z')
    ).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].model).toBe('other-model');
  });

  it('searches free text across request and response', async () => {
    const res = await authed(request(ctx.app).get('/api/audit?q=quarterly')).expect(200);
    expect(res.body.total).toBe(1);
    const res2 = await authed(request(ctx.app).get('/api/audit?q=xylophone')).expect(200);
    expect(res2.body.total).toBe(0);
  });

  it('paginates with limit/offset', async () => {
    const p1 = await authed(request(ctx.app).get('/api/audit?limit=2&offset=0')).expect(200);
    expect(p1.body.data).toHaveLength(2);
    expect(p1.body.total).toBe(3);
    const p2 = await authed(request(ctx.app).get('/api/audit?limit=2&offset=2')).expect(200);
    expect(p2.body.data).toHaveLength(1);
    expect(p2.body.data[0].id).not.toBe(p1.body.data[0].id);
  });
});
