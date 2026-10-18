import { Router } from 'express';
import { verifyApiKey } from '../lib/keys.js';
import { countUsage } from '../lib/tokens.js';
import { callUpstream } from '../lib/upstream.js';
import { checkQuota, checkRateLimit } from '../lib/limits.js';
import { redactValue } from '../lib/redact.js';

export function proxyRouter({ pool, config }) {
  const router = Router();

  router.post('/v1/proxy/chat/completions', async (req, res) => {
    const apiKey = req.get('x-api-key');
    const keyRow = await verifyApiKey(pool, apiKey);
    if (!keyRow) {
      return res
        .status(401)
        .json({ error: { message: 'Invalid or revoked API key', type: 'authentication_error' } });
    }

    // Best-effort last-used tracking; never fail a customer request for it.
    try {
      await pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [keyRow.id]);
    } catch (err) {
      console.warn('last_used_at update failed:', err.message);
    }

    // Enforce limits BEFORE forwarding — never burn upstream budget on a call
    // we are going to reject. Rejected calls are neither metered nor audited.
    const rate = await checkRateLimit(pool, keyRow);
    if (!rate.allowed) {
      return res.status(429).json({
        error: {
          message: `Rate limit exceeded: ${rate.limit} requests per minute`,
          type: 'rate_limit_error',
          retry_after_seconds: 60,
        },
      });
    }

    const quota = await checkQuota(pool, keyRow);
    if (!quota.allowed) {
      return res.status(429).json({
        error: {
          message: `Monthly token quota exceeded (${quota.used}/${quota.quota} tokens used)`,
          type: 'quota_error',
        },
      });
    }

    const model = req.body?.model || 'unknown';
    let upstreamBody;
    try {
      upstreamBody = await callUpstream({ body: req.body, config });
    } catch (err) {
      const status = err.status && err.status < 500 ? err.status : 502;
      return res
        .status(status)
        .json({ error: { message: 'Upstream request failed', type: 'upstream_error' } });
    }

    const usage = countUsage({ requestBody: req.body, responseBody: upstreamBody });

    // Meter + audit atomically: one transaction, both rows or neither.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO usage_events (key_id, model, prompt_tokens, completion_tokens, total_tokens)
         VALUES ($1, $2, $3, $4, $5)`,
        [keyRow.id, model, usage.prompt_tokens, usage.completion_tokens, usage.total_tokens]
      );
      await client.query(
        `INSERT INTO audit_logs (key_id, model, request_redacted, response_redacted)
         VALUES ($1, $2, $3, $4)`,
        [
          keyRow.id,
          model,
          JSON.stringify(redactValue({ model, messages: req.body?.messages ?? [] })),
          JSON.stringify(
            redactValue({ choices: upstreamBody.choices ?? [], usage: upstreamBody.usage ?? null })
          ),
        ]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return res.json(upstreamBody);
  });

  return router;
}
