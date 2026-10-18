import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { testContext, seedUser } from './helpers.js';
import { createApiKey } from '../src/lib/keys.js';

const chatBody = {
  model: 'mock-model',
  messages: [{ role: 'user', content: 'Hello' }],
};

describe('quota and rate limits', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await testContext({ mockUpstream: 'true' });
  });
  afterEach(async () => {
    await ctx.pool.end();
  });

  async function issueKey(opts = {}) {
    const user = await seedUser(ctx.pool);
    return createApiKey(ctx.pool, { name: 'limit-key', userId: user.id, ...opts });
  }

  it('returns 429 when the monthly quota is exhausted (and does not forward)', async () => {
    const issued = await issueKey({ monthlyQuotaTokens: 10 });
    // burn the whole quota directly
    await ctx.pool.query(
      `INSERT INTO usage_events (key_id, model, prompt_tokens, completion_tokens, total_tokens)
       VALUES ($1, 'mock-model', 6, 4, 10)`,
      [issued.id]
    );

    const res = await request(ctx.app)
      .post('/v1/proxy/chat/completions')
      .set('x-api-key', issued.key)
      .send(chatBody)
      .expect(429);

    expect(res.body.error.type).toBe('quota_error');
    // rejected call: no new usage row, no audit row
    const { rows } = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM usage_events');
    expect(rows[0].n).toBe(1);
    const audit = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM audit_logs');
    expect(audit.rows[0].n).toBe(0);
  });

  it('allows calls under quota and meters them', async () => {
    const issued = await issueKey({ monthlyQuotaTokens: 1_000_000 });
    await request(ctx.app)
      .post('/v1/proxy/chat/completions')
      .set('x-api-key', issued.key)
      .send(chatBody)
      .expect(200);
    const { rows } = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM usage_events');
    expect(rows[0].n).toBe(1);
  });

  it('returns 429 when the per-minute rate limit is exceeded', async () => {
    const issued = await issueKey({ rateLimitPerMin: 1 });
    await request(ctx.app)
      .post('/v1/proxy/chat/completions')
      .set('x-api-key', issued.key)
      .send(chatBody)
      .expect(200);

    const res = await request(ctx.app)
      .post('/v1/proxy/chat/completions')
      .set('x-api-key', issued.key)
      .send(chatBody)
      .expect(429);
    expect(res.body.error.type).toBe('rate_limit_error');

    const { rows } = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM usage_events');
    expect(rows[0].n).toBe(1); // only the first call was metered
  });

  it('writes a PII-redacted audit row on success', async () => {
    const issued = await issueKey();
    const piiBody = {
      model: 'mock-model',
      messages: [
        {
          role: 'user',
          content: 'Hi, I am jane.doe@example.com, phone +1-555-123-4567, key sk-abcdefghijklmnop1234',
        },
      ],
    };
    await request(ctx.app)
      .post('/v1/proxy/chat/completions')
      .set('x-api-key', issued.key)
      .send(piiBody)
      .expect(200);

    const { rows } = await ctx.pool.query('SELECT * FROM audit_logs');
    expect(rows).toHaveLength(1);
    expect(rows[0].key_id).toBe(issued.id);
    expect(rows[0].model).toBe('mock-model');
    const reqText = JSON.stringify(rows[0].request_redacted);
    expect(reqText).toContain('[EMAIL_REDACTED]');
    expect(reqText).toContain('[PHONE_REDACTED]');
    expect(reqText).toContain('[SECRET_REDACTED]');
    expect(reqText).not.toContain('jane.doe@example.com');
    expect(reqText).not.toContain('+1-555-123-4567');
    expect(reqText).not.toContain('sk-abcdefghijklmnop1234');
  });

  it('does not audit rejected (401) calls', async () => {
    await request(ctx.app)
      .post('/v1/proxy/chat/completions')
      .set('x-api-key', 'tt_live_nope0000000000000000000000000000000')
      .send(chatBody)
      .expect(401);
    const { rows } = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM audit_logs');
    expect(rows[0].n).toBe(0);
  });
});
