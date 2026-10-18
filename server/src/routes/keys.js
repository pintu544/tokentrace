import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { createApiKey, revokeApiKey } from '../lib/keys.js';

/**
 * Dashboard API-key management.
 *   GET    /api/keys            — list (admin + viewer)
 *   POST   /api/keys            — issue (admin only; plaintext key shown once)
 *   PATCH  /api/keys/:id        — quota/rate-limit config (admin only)
 *   POST   /api/keys/:id/revoke — revoke (admin only)
 */
export function keysRouter({ pool, config }) {
  const router = Router();
  const auth = requireAuth({ jwtSecret: config.jwtSecret });

  router.use(auth);

  const publicRow = (r) => ({
    id: r.id,
    key_prefix: r.key_prefix,
    name: r.name,
    monthly_quota_tokens: Number(r.monthly_quota_tokens),
    rate_limit_per_min: r.rate_limit_per_min,
    revoked_at: r.revoked_at,
    last_used_at: r.last_used_at,
    created_at: r.created_at,
  });

  router.get('/api/keys', async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, key_prefix, name, monthly_quota_tokens, rate_limit_per_min,
              revoked_at, last_used_at, created_at
       FROM api_keys ORDER BY created_at DESC, id DESC`
    );
    return res.json({ data: rows.map(publicRow) });
  });

  router.post('/api/keys', requireRole('admin'), async (req, res) => {
    const { name, monthlyQuotaTokens, rateLimitPerMin } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: { message: 'A key name is required' } });
    }
    const quota = monthlyQuotaTokens === undefined ? 1_000_000 : Number(monthlyQuotaTokens);
    const rate = rateLimitPerMin === undefined ? 60 : Number(rateLimitPerMin);
    if (!Number.isFinite(quota) || quota < 0 || !Number.isInteger(rate) || rate < 1) {
      return res.status(400).json({ error: { message: 'Invalid quota or rate limit' } });
    }
    const row = await createApiKey(pool, {
      name: name.trim(),
      userId: req.user.id,
      monthlyQuotaTokens: quota,
      rateLimitPerMin: rate,
    });
    // The plaintext key is returned exactly once — it is never stored.
    return res.status(201).json({ data: { ...publicRow(row), key: row.key } });
  });

  router.patch('/api/keys/:id', requireRole('admin'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: { message: 'Invalid key id' } });
    }
    const updates = [];
    const params = [];
    const { monthlyQuotaTokens, rateLimitPerMin, name } = req.body || {};
    if (monthlyQuotaTokens !== undefined) {
      const quota = Number(monthlyQuotaTokens);
      if (!Number.isFinite(quota) || quota < 0) {
        return res.status(400).json({ error: { message: 'Invalid quota' } });
      }
      params.push(quota);
      updates.push(`monthly_quota_tokens = $${params.length}`);
    }
    if (rateLimitPerMin !== undefined) {
      const rate = Number(rateLimitPerMin);
      if (!Number.isInteger(rate) || rate < 1) {
        return res.status(400).json({ error: { message: 'Invalid rate limit' } });
      }
      params.push(rate);
      updates.push(`rate_limit_per_min = $${params.length}`);
    }
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: { message: 'Invalid name' } });
      }
      params.push(name.trim());
      updates.push(`name = $${params.length}`);
    }
    if (!updates.length) {
      return res.status(400).json({ error: { message: 'Nothing to update' } });
    }
    params.push(id);
    const { rows } = await pool.query(
      `UPDATE api_keys SET ${updates.join(', ')} WHERE id = $${params.length}
       RETURNING id, key_prefix, name, monthly_quota_tokens, rate_limit_per_min,
                 revoked_at, last_used_at, created_at`,
      params
    );
    if (!rows.length) {
      return res.status(404).json({ error: { message: 'Key not found' } });
    }
    return res.json({ data: publicRow(rows[0]) });
  });

  router.post('/api/keys/:id/revoke', requireRole('admin'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: { message: 'Invalid key id' } });
    }
    const revoked = await revokeApiKey(pool, id);
    if (!revoked) {
      return res.status(404).json({ error: { message: 'Key not found or already revoked' } });
    }
    return res.json({ ok: true });
  });

  return router;
}
