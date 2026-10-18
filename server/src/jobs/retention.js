/**
 * Nightly retention purge: deletes audit_logs older than settings.retention_days.
 *
 * Importable/testable: `purgeOldAuditLogs(pool)` returns { deleted, retentionDays }.
 * Runnable as a script: `node src/jobs/retention.js` (needs DATABASE_URL) or
 * `npm run retention`. Schedule nightly via cron/Render cron job in production.
 */
import { fileURLToPath } from 'node:url';
import { createPool } from '../db.js';

export async function getRetentionDays(pool) {
  const { rows } = await pool.query('SELECT retention_days FROM settings WHERE id = 1');
  return rows.length ? Number(rows[0].retention_days) : 30;
}

export async function purgeOldAuditLogs(pool) {
  const retentionDays = await getRetentionDays(pool);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const { rowCount } = await pool.query('DELETE FROM audit_logs WHERE created_at < $1', [
    cutoff.toISOString(),
  ]);
  return { deleted: rowCount, retentionDays };
}

const invokedAsScript =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedAsScript) {
  const pool = createPool();
  try {
    const { deleted, retentionDays } = await purgeOldAuditLogs(pool);
    console.log(
      `retention: deleted ${deleted} audit log(s) older than ${retentionDays} day(s)`
    );
  } finally {
    await pool.end();
  }
}
