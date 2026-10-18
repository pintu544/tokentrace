import { Router } from 'express';
import { createHash } from 'node:crypto';
import { verifyApiKey } from '../lib/keys.js';
import { countUsage } from '../lib/tokens.js';
import { callUpstream } from '../lib/upstream.js';
import { callRestUpstream } from '../lib/restUpstream.js';
import { checkQuota, checkRateLimit } from '../lib/limits.js';
import { redactValue } from '../lib/redact.js';

/**
 * Read the request body for the REST passthrough. JSON bodies were already
 * parsed by express.json(); anything else (multipart uploads, raw bytes) is
 * read from the stream untouched so boundaries/encodings survive.
 */
async function readRestBody(req) {
  const contentType = req.get('content-type') || '';
  if (
    contentType.includes('application/json') &&
    req.body !== undefined &&
    req.body !== null &&
    typeof req.body === 'object'
  ) {
    return { buffer: Buffer.from(JSON.stringify(req.body), 'utf8'), isJson: true };
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return { buffer: Buffer.concat(chunks), isJson: false };
}

/** Audit payload for a body: redacted JSON, or metadata for binary content. */
function auditBody({ buffer, isJson, contentType }) {
  if (isJson) {
    try {
      return redactValue(JSON.parse(buffer.toString('utf8')));
    } catch {
      // fall through to metadata
    }
  }
  return {
    _binary: true,
    content_type: contentType || 'unknown',
    byte_size: buffer.length,
    sha256_prefix: createHash('sha256').update(buffer).digest('hex').slice(0, 16),
  };
}

function quotaError(quota) {
  return {
    error: {
      message: `Monthly token quota exceeded (${quota.used}/${quota.quota} tokens used)`,
      type: 'quota_error',
    },
  };
}

function rateLimitError(rate) {
  return {
    error: {
      message: `Rate limit exceeded: ${rate.limit} requests per minute`,
      type: 'rate_limit_error',
      retry_after_seconds: 60,
    },
  };
}

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

  /**
   * Generic REST passthrough: ANY /v1/proxy/upstream/* forwards method, path
   * suffix, query string and body to ${UPSTREAM_BASE_URL}, injecting the
   * server-side upstream key as Authorization: Bearer.
   *
   * Enforcement order matches the chat path: key verify → rate limit → quota
   * BEFORE forwarding (never burn upstream budget on a rejected call).
   * Rejected calls are neither metered nor audited; neither are failed
   * upstream calls (non-2xx is passed through verbatim, unmetered).
   *
   * Metering: REST upstreams expose no token usage, so "tokens" are
   * SIZE-ESTIMATED — ceil(bytes/4), split by direction (request = prompt,
   * response = completion) — not model-counted. Quotas, rate limits, stats
   * and billing consume usage_events identically to the chat path.
   */
  router.all('/v1/proxy/upstream/*', async (req, res) => {
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

    const rate = await checkRateLimit(pool, keyRow);
    if (!rate.allowed) {
      return res.status(429).json(rateLimitError(rate));
    }

    const quota = await checkQuota(pool, keyRow);
    if (!quota.allowed) {
      return res.status(429).json(quotaError(quota));
    }

    const suffix = req.params[0] || '';
    const query = req.originalUrl.includes('?')
      ? req.originalUrl.split('?').slice(1).join('?')
      : '';
    const contentType = req.get('content-type') || '';
    const { buffer: reqBuffer, isJson } = await readRestBody(req);

    let upstream;
    try {
      upstream = await callRestUpstream({
        method: req.method,
        suffix,
        query,
        headers: req.headers,
        body: reqBuffer,
        contentType: isJson ? 'application/json' : contentType,
        config,
      });
    } catch (err) {
      if (err.status === 504) {
        return res
          .status(504)
          .json({ error: { message: 'Upstream request timed out', type: 'upstream_timeout' } });
      }
      const status = err.status && err.status < 500 ? err.status : 502;
      return res
        .status(status)
        .json({ error: { message: 'Upstream request failed', type: 'upstream_error' } });
    }

    // Non-2xx passes through verbatim and is NOT metered or audited —
    // customers are never billed for failed upstream calls.
    if (upstream.status < 200 || upstream.status >= 300) {
      return res.status(upstream.status).set('Content-Type', upstream.contentType).send(upstream.body);
    }

    const prompt_tokens = Math.ceil(reqBuffer.length / 4);
    const completion_tokens = Math.ceil(upstream.body.length / 4);
    const total_tokens = prompt_tokens + completion_tokens;
    const model = 'rest:' + (suffix.split('/').filter(Boolean)[0] || 'root');

    // Meter + audit atomically: one transaction, both rows or neither.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO usage_events (key_id, model, prompt_tokens, completion_tokens, total_tokens)
         VALUES ($1, $2, $3, $4, $5)`,
        [keyRow.id, model, prompt_tokens, completion_tokens, total_tokens]
      );
      await client.query(
        `INSERT INTO audit_logs (key_id, model, request_redacted, response_redacted)
         VALUES ($1, $2, $3, $4)`,
        [
          keyRow.id,
          model,
          JSON.stringify(auditBody({ buffer: reqBuffer, isJson, contentType })),
          JSON.stringify(
            auditBody({
              buffer: upstream.body,
              isJson: (upstream.contentType || '').includes('application/json'),
              contentType: upstream.contentType,
            })
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

    return res.status(upstream.status).set('Content-Type', upstream.contentType).send(upstream.body);
  });

  return router;
}
