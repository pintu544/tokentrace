import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

/**
 * Dashboard audit-log API (Slice 2; auth hardened in Slice 3).
 *
 * GET /api/audit?key_id=&from=&to=&model=&q=&limit=&offset=
 *   key_id : integer, filter to one API key
 *   from/to: ISO date strings, inclusive bounds on created_at
 *   model  : exact model name match
 *   q      : free-text ILIKE over the redacted request/response JSON
 *   limit  : default 50, max 500 · offset: default 0
 */
export function auditRouter({ pool, config }) {
  const router = Router();

  router.use(requireAuth({ jwtSecret: config.jwtSecret }));

  router.get('/api/audit', async (req, res) => {
    const where = [];
    const params = [];
    const add = (clause, value) => {
      params.push(value);
      where.push(`${clause} $${params.length}`);
    };

    if (req.query.key_id !== undefined) {
      const keyId = Number(req.query.key_id);
      if (!Number.isInteger(keyId)) {
        return res.status(400).json({ error: { message: 'key_id must be an integer' } });
      }
      add('key_id =', keyId);
    }
    if (req.query.from) add('created_at >=', req.query.from);
    if (req.query.to) add('created_at <=', req.query.to);
    if (req.query.model) add('model =', req.query.model);
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      const n = params.length;
      where.push(
        `(request_redacted::text ILIKE $${n} OR response_redacted::text ILIKE $${n})`
      );
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT id, key_id, model, request_redacted, response_redacted, created_at
       FROM audit_logs ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM audit_logs ${whereSql}`,
      params
    );
    return res.json({ data: rows, total: countRows[0].total, limit, offset });
  });

  return router;
}
