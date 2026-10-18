/**
 * Quota + rate-limit enforcement for the proxy.
 *
 * NOTE (scale tradeoff): both checks count rows in usage_events per request,
 * which is O(n) in the key's history. Fine for hackathon/demo scale; a
 * production deployment would keep rolling counters (Redis or a
 * per-key-per-minute bucket table) instead of scanning the events table.
 */

/**
 * Start of the current calendar month (computed in JS so the query stays
 * portable — pg-mem, used in tests, does not implement date_trunc).
 */
export function monthStart(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** Total tokens consumed by a key in the current calendar month. */
export async function monthlyUsage(pool, keyId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(total_tokens), 0)::bigint AS total
     FROM usage_events
     WHERE key_id = $1 AND created_at >= $2`,
    [keyId, monthStart().toISOString()]
  );
  return Number(rows[0].total);
}

/**
 * Check the key's monthly token quota BEFORE forwarding (never burn upstream
 * budget on a call we will reject). Returns { allowed, used, quota }.
 */
export async function checkQuota(pool, keyRow) {
  const quota = Number(keyRow.monthly_quota_tokens);
  const used = await monthlyUsage(pool, keyRow.id);
  return { allowed: used < quota, used, quota };
}

/** Proxy calls by a key in the trailing 60 seconds. */
export async function recentCallCount(pool, keyId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM usage_events
     WHERE key_id = $1 AND created_at > now() - interval '60 seconds'`,
    [keyId]
  );
  return rows[0].n;
}

/** Check the per-minute rate limit. Returns { allowed, count, limit }. */
export async function checkRateLimit(pool, keyRow) {
  const limit = Number(keyRow.rate_limit_per_min);
  const count = await recentCallCount(pool, keyRow.id);
  return { allowed: count < limit, count, limit };
}
