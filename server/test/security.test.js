/**
 * Slice 5 — security hardening tests.
 * Headers, CORS allowlist, body size limits, timing-safe key comparison,
 * and the no-stack-trace error handler.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { testContext, seedUser } from './helpers.js';
import { createApp } from '../src/app.js';
import { createApiKey, verifyApiKey } from '../src/lib/keys.js';

async function contextWith({ corsOrigins = [], restBodyLimitBytes = 10 * 1024 * 1024 } = {}) {
  const ctx = await testContext();
  const config = { ...ctx.config, corsOrigins, restBodyLimitBytes };
  const app = createApp({ pool: ctx.pool, config });
  return { ...ctx, app, config };
}

describe('security headers', () => {
  it('sets hardening headers and hides x-powered-by', async () => {
    const { app } = await contextWith();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('CORS', () => {
  it('denies by default: no ACAO header for unlisted origins', async () => {
    const { app } = await contextWith();
    const res = await request(app).get('/health').set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows listed origins and answers preflight', async () => {
    const { app } = await contextWith({ corsOrigins: ['https://dash.example.com'] });
    const res = await request(app).get('/health').set('Origin', 'https://dash.example.com');
    expect(res.headers['access-control-allow-origin']).toBe('https://dash.example.com');
    expect(res.headers['vary']).toContain('Origin');

    const pre = await request(app)
      .options('/v1/proxy/chat/completions')
      .set('Origin', 'https://dash.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(pre.status).toBe(204);
  });

  it('rejects preflight from non-allowlisted origins', async () => {
    const { app } = await contextWith({ corsOrigins: ['https://dash.example.com'] });
    const res = await request(app)
      .options('/v1/proxy/chat/completions')
      .set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });
});

describe('body size limits', () => {
  it('rejects oversized non-JSON REST bodies with 413', async () => {
    const { app, pool } = await contextWith({ restBodyLimitBytes: 100 });
    const user = await seedUser(pool);
    const { key } = await createApiKey(pool, { name: 't', userId: user.id });
    const big = Buffer.alloc(101, 'a');
    const res = await request(app)
      .post('/v1/proxy/upstream/echo')
      .set('x-api-key', key)
      .set('Content-Type', 'application/octet-stream')
      .send(big);
    expect(res.status).toBe(413);
    expect(res.body.error.type).toBe('body_too_large');
  });

  it('rejects oversized JSON bodies with 413 and no stack trace', async () => {
    const { app } = await contextWith();
    const huge = { data: 'x'.repeat(3 * 1024 * 1024) };
    const res = await request(app).post('/v1/proxy/chat/completions').send(huge);
    expect(res.status).toBe(413);
    expect(JSON.stringify(res.body)).not.toContain('stack');
  });

  it('returns 400 (not a stack trace) for malformed JSON', async () => {
    const { app } = await contextWith();
    const res = await request(app)
      .post('/v1/proxy/chat/completions')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('at ');
  });
});

describe('timing-safe key verification', () => {
  it('accepts the correct key', async () => {
    const { pool } = await contextWith();
    const user = await seedUser(pool);
    const { key, id } = await createApiKey(pool, { name: 't', userId: user.id });
    const row = await verifyApiKey(pool, key);
    expect(row?.id).toBe(id);
  });

  it('rejects a key that shares the prefix but differs in the secret part', async () => {
    const { pool } = await contextWith();
    const user = await seedUser(pool);
    const { key } = await createApiKey(pool, { name: 't', userId: user.id });
    const forged = key.slice(0, -1) + (key.endsWith('0') ? '1' : '0');
    expect(await verifyApiKey(pool, forged)).toBeNull();
  });

  it('rejects unknown keys and malformed input without throwing', async () => {
    const { pool } = await contextWith();
    expect(await verifyApiKey(pool, 'tt_live_00000000000000000000000000000000000000000')).toBeNull();
    expect(await verifyApiKey(pool, 'not-a-key')).toBeNull();
    expect(await verifyApiKey(pool, '')).toBeNull();
    expect(await verifyApiKey(pool, null)).toBeNull();
  });
});
