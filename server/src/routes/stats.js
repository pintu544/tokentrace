import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

/**
 * Dashboard usage statistics (admin + viewer).
 *   GET /api/stats/overview — tokens/requests today + this month, top keys this month
 *   GET /api/stats/daily?days=30 — per-day totals for the last N days (max 90)
 *
 * Day/month boundaries are computed in JS (pg-mem has no date_trunc; the SQL
 * stays portable to real Postgres).
 */
export function statsRouter({ pool, config }) {
  const router = Router();
  router.use(requireAuth({ jwtSecret: config.jwtSecret }));

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function startOfMonth(d) {
    const x = new Date(d);
    x.setDate(1);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  router.get('/api/stats/overview', async (req, res) => {
    const now = new Date();
    const dayStart = startOfDay(now);
    const monthStart = startOfMonth(now);

    const { rows: dayRows } = await pool.query(
      `SELECT COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
              COUNT(*)::int AS requests
       FROM usage_events WHERE created_at >= $1`,
      [dayStart.toISOString()]
    );
    const { rows: monthRows } = await pool.query(
      `SELECT COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
              COUNT(*)::int AS requests
       FROM usage_events WHERE created_at >= $1`,
      [monthStart.toISOString()]
    );
    const { rows: topKeys } = await pool.query(
      `SELECT k.id, k.key_prefix, k.name,
              COALESCE(SUM(u.total_tokens), 0)::bigint AS tokens,
              COUNT(u.id)::int AS requests
       FROM api_keys k
       LEFT JOIN usage_events u ON u.key_id = k.id AND u.created_at >= $1
       GROUP BY k.id, k.key_prefix, k.name
       ORDER BY tokens DESC, k.id ASC
       LIMIT 10`,
      [monthStart.toISOString()]
    );

    return res.json({
      today: {
        tokens: Number(dayRows[0].tokens),
        requests: dayRows[0].requests,
      },
      month: {
        tokens: Number(monthRows[0].tokens),
        requests: monthRows[0].requests,
      },
      topKeys: topKeys.map((r) => ({
        id: r.id,
        key_prefix: r.key_prefix,
        name: r.name,
        tokens: Number(r.tokens),
        requests: r.requests,
      })),
    });
  });

  router.get('/api/stats/daily', async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
    const now = new Date();
    const from = startOfDay(now);
    from.setDate(from.getDate() - (days - 1));

    const { rows } = await pool.query(
      `SELECT created_at, total_tokens FROM usage_events WHERE created_at >= $1`,
      [from.toISOString()]
    );

    // Bucket in JS: one bucket per calendar day, zero-filled.
    const buckets = new Map();
    for (let i = 0; i < days; i++) {
      const d = new Date(from);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      buckets.set(key, { date: key, tokens: 0, requests: 0 });
    }
    for (const r of rows) {
      const key = new Date(r.created_at).toISOString().slice(0, 10);
      const b = buckets.get(key);
      if (b) {
        b.tokens += Number(r.total_tokens);
        b.requests += 1;
      }
    }
    return res.json({ data: [...buckets.values()] });
  });

  return router;
}
