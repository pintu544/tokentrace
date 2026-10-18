import { Router } from 'express';
import { verifyApiKey } from '../lib/keys.js';
import { countUsage } from '../lib/tokens.js';
import { callUpstream } from '../lib/upstream.js';

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
    await pool.query(
      `INSERT INTO usage_events (key_id, model, prompt_tokens, completion_tokens, total_tokens)
       VALUES ($1, $2, $3, $4, $5)`,
      [keyRow.id, model, usage.prompt_tokens, usage.completion_tokens, usage.total_tokens]
    );

    return res.json(upstreamBody);
  });

  return router;
}
