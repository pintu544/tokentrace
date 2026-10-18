import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { testContext, seedUser } from './helpers.js';
import { createApiKey } from '../src/lib/keys.js';
import { getLastMockRequest } from '../src/lib/restUpstream.js';

async function issueKey(pool, overrides = {}) {
  const user = await seedUser(pool);
  return createApiKey(pool, { name: 'rest-key', userId: user.id, ...overrides });
}

describe('REST upstream passthrough', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await testContext({ mockUpstream: 'true' });
    // The mock asserts what Authorization the real call would carry.
    // 'mock-key' is a fixture value — never a real credential.
    ctx.config.upstreamApiKey = 'mock-key';
  });
  afterEach(async () => {
    await ctx.pool.end();
  });

  it('proxies GET, preserving the path suffix and query string', async () => {
    const issued = await issueKey(ctx.pool);
    const res = await request(ctx.app)
      .get('/v1/proxy/upstream/api/task?task_id=abc123&verbose=1')
      .set('x-api-key', issued.key)
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.echoed_method).toBe('GET');
    expect(res.body.echoed_path).toBe('/api/task?task_id=abc123&verbose=1');
  });

  it('forwards POST JSON with the server-side Bearer key injected', async () => {
    const issued = await issueKey(ctx.pool);
    const payload = { image_url: 'https://example.com/face.jpg', email: 'user@example.com' };
    const res = await request(ctx.app)
      .post('/v1/proxy/upstream/api/create_task')
      .set('x-api-key', issued.key)
      .send(payload)
      .expect(200);

    expect(res.body.echoed_method).toBe('POST');
    const seen = getLastMockRequest();
    expect(seen.authorization).toBe('Bearer mock-key');
    // The client's TokenTrace key must never reach the upstream.
    expect(JSON.stringify(seen)).not.toContain(issued.key.slice(0, 20));
  });

  it('returns 401 for missing or bad x-api-key and meters nothing', async () => {
    await request(ctx.app).get('/v1/proxy/upstream/api/task').expect(401);
    await request(ctx.app)
      .get('/v1/proxy/upstream/api/task')
      .set('x-api-key', 'tt_live_doesnotexist0000000000000000000000000')
      .expect(401);

    const { rows } = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM usage_events');
    expect(rows[0].n).toBe(0);
  });

  it('enforces the monthly quota on the REST path (429, unmetered)', async () => {
    const issued = await issueKey(ctx.pool, { monthlyQuotaTokens: 10 });
    // One call consumes ceil(bytes/4) each way — well over a 10-token quota.
    await request(ctx.app)
      .post('/v1/proxy/upstream/api/create_task')
      .set('x-api-key', issued.key)
      .send({ data: 'x'.repeat(100) })
      .expect(200);

    const res = await request(ctx.app)
      .get('/v1/proxy/upstream/api/task')
      .set('x-api-key', issued.key)
      .expect(429);
    expect(res.body.error.type).toBe('quota_error');

    const { rows } = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM usage_events');
    expect(rows[0].n).toBe(1); // the rejected call was not metered
  });

  it('enforces the per-minute rate limit on the REST path (429)', async () => {
    const issued = await issueKey(ctx.pool, { rateLimitPerMin: 1 });
    await request(ctx.app)
      .get('/v1/proxy/upstream/api/task')
      .set('x-api-key', issued.key)
      .expect(200);

    const res = await request(ctx.app)
      .get('/v1/proxy/upstream/api/task')
      .set('x-api-key', issued.key)
      .expect(429);
    expect(res.body.error.type).toBe('rate_limit_error');
  });

  it('records usage with size-estimated tokens', async () => {
    const issued = await issueKey(ctx.pool);
    const body = JSON.stringify({ a: '12345678' }); // 16 bytes → 4 prompt tokens
    await request(ctx.app)
      .post('/v1/proxy/upstream/api/create_task')
      .set('x-api-key', issued.key)
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);

    const { rows } = await ctx.pool.query('SELECT * FROM usage_events');
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe('rest:api');
    expect(rows[0].prompt_tokens).toBe(Math.ceil(Buffer.byteLength(body) / 4));
    expect(rows[0].completion_tokens).toBeGreaterThan(0);
    expect(rows[0].total_tokens).toBe(rows[0].prompt_tokens + rows[0].completion_tokens);
  });

  it('audits JSON bodies with PII redacted', async () => {
    const issued = await issueKey(ctx.pool);
    await request(ctx.app)
      .post('/v1/proxy/upstream/api/create_task')
      .set('x-api-key', issued.key)
      .send({ email: 'user@example.com', note: 'plain text' })
      .expect(200);

    const { rows } = await ctx.pool.query('SELECT * FROM audit_logs');
    expect(rows).toHaveLength(1);
    // pg-mem returns jsonb as a parsed object; real Postgres returns a string.
    const reqAudit =
      typeof rows[0].request_redacted === 'string'
        ? JSON.parse(rows[0].request_redacted)
        : rows[0].request_redacted;
    expect(reqAudit.email).toBe('[EMAIL_REDACTED]');
    expect(reqAudit.note).toBe('plain text');
  });

  it('stores binary upload bodies as metadata, never bytes', async () => {
    const issued = await issueKey(ctx.pool);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xde, 0xad, 0xbe, 0xef]);
    await request(ctx.app)
      .post('/v1/proxy/upstream/api/upload')
      .set('x-api-key', issued.key)
      .set('Content-Type', 'application/octet-stream')
      .send(bytes)
      .expect(200);

    const { rows } = await ctx.pool.query('SELECT * FROM audit_logs');
    expect(rows).toHaveLength(1);
    // pg-mem returns jsonb as a parsed object; real Postgres returns a string.
    const reqAudit =
      typeof rows[0].request_redacted === 'string'
        ? JSON.parse(rows[0].request_redacted)
        : rows[0].request_redacted;
    expect(reqAudit._binary).toBe(true);
    expect(reqAudit.content_type).toBe('application/octet-stream');
    expect(reqAudit.byte_size).toBe(bytes.length);
    expect(reqAudit.sha256_prefix).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(reqAudit)).not.toContain('PNG');
  });

  it('passes non-2xx upstream responses through verbatim, unmetered and unaudited', async () => {
    const issued = await issueKey(ctx.pool);
    const res = await request(ctx.app)
      .post('/v1/proxy/upstream/__fail500/api/create_task')
      .set('x-api-key', issued.key)
      .send({ a: 1 })
      .expect(500);
    expect(res.body.error).toBe('mock upstream failure');

    const { rows: usage } = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM usage_events');
    const { rows: audit } = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM audit_logs');
    expect(usage[0].n).toBe(0);
    expect(audit[0].n).toBe(0);
  });

  it('preserves the HTTP method (PUT/DELETE)', async () => {
    const issued = await issueKey(ctx.pool);
    const put = await request(ctx.app)
      .put('/v1/proxy/upstream/api/task/1')
      .set('x-api-key', issued.key)
      .send({ status: 'cancel' })
      .expect(200);
    expect(put.body.echoed_method).toBe('PUT');

    const del = await request(ctx.app)
      .delete('/v1/proxy/upstream/api/task/1')
      .set('x-api-key', issued.key)
      .expect(200);
    expect(del.body.echoed_method).toBe('DELETE');
  });
});
