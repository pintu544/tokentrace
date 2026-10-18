import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newDb } from 'pg-mem';
import { migrate } from '../src/db.js';
import { purgeOldAuditLogs, getRetentionDays } from '../src/jobs/retention.js';
import { seedUser } from './helpers.js';
import { createApiKey } from '../src/lib/keys.js';

async function freshPool() {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  return pool;
}

async function insertAuditAt(pool, keyId, isoDate) {
  await pool.query(
    `INSERT INTO audit_logs (key_id, model, request_redacted, response_redacted, created_at)
     VALUES ($1, 'mock-model', '{}'::jsonb, '{}'::jsonb, $2)`,
    [keyId, isoDate]
  );
}

describe('retention purge', () => {
  let pool;
  let keyId;
  beforeEach(async () => {
    pool = await freshPool();
    const user = await seedUser(pool);
    const issued = await createApiKey(pool, { name: 'k', userId: user.id });
    keyId = issued.id;
  });
  afterEach(async () => {
    await pool.end();
  });

  it('reads the configured retention window (default 30)', async () => {
    expect(await getRetentionDays(pool)).toBe(30);
  });

  it('deletes only rows older than the retention window', async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await insertAuditAt(pool, keyId, old);
    await insertAuditAt(pool, keyId, recent);

    const { deleted, retentionDays } = await purgeOldAuditLogs(pool);
    expect(retentionDays).toBe(30);
    expect(deleted).toBe(1);

    const { rows } = await pool.query('SELECT created_at FROM audit_logs');
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].created_at).toISOString()).toBe(recent);
  });

  it('honors a custom retention window', async () => {
    await pool.query('UPDATE settings SET retention_days = 7 WHERE id = 1');
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await insertAuditAt(pool, keyId, old);

    const { deleted, retentionDays } = await purgeOldAuditLogs(pool);
    expect(retentionDays).toBe(7);
    expect(deleted).toBe(1);
  });
});
