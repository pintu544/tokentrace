import { newDb } from 'pg-mem';
import { migrate } from '../src/db.js';
import { createApp, loadConfig } from '../src/app.js';

/** Fresh in-memory Postgres + migrated schema + Express app. No network needed. */
export async function testContext({ mockUpstream = 'true' } = {}) {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  const config = { ...loadConfig({}), mockUpstream, upstreamBaseUrl: '', upstreamApiKey: '' };
  const app = createApp({ pool, config });
  return { pool, app, config };
}

export async function seedUser(pool, email = 'owner@example.com') {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'test-hash') RETURNING id`,
    [email]
  );
  return rows[0];
}
