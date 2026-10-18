import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { testContext, seedUser } from './helpers.js';
import { createApiKey } from '../src/lib/keys.js';

const chatBody = {
  model: 'mock-model',
  messages: [{ role: 'user', content: 'Hello, how are you?' }],
};

async function issueKey(pool) {
  const user = await seedUser(pool);
  return createApiKey(pool, { name: 'proxy-key', userId: user.id });
}

describe('proxy', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await testContext({ mockUpstream: 'true' });
  });
  afterEach(async () => {
    await ctx.pool.end();
  });

  it('exposes a health endpoint', async () => {
    const res = await request(ctx.app).get('/health').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('tokentrace-api');
  });

  it('proxies a chat completion and records usage from the upstream usage block', async () => {
    const issued = await issueKey(ctx.pool);
    const res = await request(ctx.app)
      .post('/v1/proxy/chat/completions')
      .set('x-api-key', issued.key)
      .send(chatBody)
      .expect(200);

    expect(res.body.choices?.[0]?.message?.role).toBe('assistant');
    expect(res.body.usage.total_tokens).toBeGreaterThan(0);

    const { rows } = await ctx.pool.query('SELECT * FROM usage_events');
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe('mock-model');
    expect(rows[0].prompt_tokens).toBe(res.body.usage.prompt_tokens);
    expect(rows[0].completion_tokens).toBe(res.body.usage.completion_tokens);
    expect(rows[0].total_tokens).toBe(res.body.usage.total_tokens);
  });

  it('returns 401 for missing, bad, or revoked keys', async () => {
    const issued = await issueKey(ctx.pool);

    await request(ctx.app)
      .post('/v1/proxy/chat/completions')
      .set('x-api-key', 'tt_live_doesnotexist0000000000000000000000000')
      .send(chatBody)
      .expect(401);

    await request(ctx.app).post('/v1/proxy/chat/completions').send(chatBody).expect(401);

    await ctx.pool.query('UPDATE api_keys SET revoked_at = now()');
    await request(ctx.app)
      .post('/v1/proxy/chat/completions')
      .set('x-api-key', issued.key)
      .send(chatBody)
      .expect(401);

    const { rows } = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM usage_events');
    expect(rows[0].n).toBe(0); // rejected calls are never metered
  });

  it('rejects malformed JSON with 400', async () => {
    const issued = await issueKey(ctx.pool);
    await request(ctx.app)
      .post('/v1/proxy/chat/completions')
      .set('x-api-key', issued.key)
      .set('Content-Type', 'application/json')
      .send('{"broken":')
      .expect(400);
  });

  it('estimates tokens when the upstream omits the usage block', async () => {
    await ctx.pool.end();
    ctx = await testContext({ mockUpstream: 'no-usage' });

    const issued = await issueKey(ctx.pool);
    const res = await request(ctx.app)
      .post('/v1/proxy/chat/completions')
      .set('x-api-key', issued.key)
      .send(chatBody)
      .expect(200);
    expect(res.body.usage).toBeUndefined();

    const { rows } = await ctx.pool.query('SELECT * FROM usage_events');
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt_tokens).toBeGreaterThan(0);
    expect(rows[0].completion_tokens).toBeGreaterThan(0);
    expect(rows[0].total_tokens).toBe(rows[0].prompt_tokens + rows[0].completion_tokens);
    // estimate = ceil(chars/4): "Hello, how are you?" is 19 chars → 5 tokens
    expect(rows[0].prompt_tokens).toBe(Math.ceil('Hello, how are you?'.length / 4));
  });
});
