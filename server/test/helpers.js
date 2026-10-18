import { newDb } from 'pg-mem';
import { migrate } from '../src/db.js';
import { createApp, loadConfig } from '../src/app.js';
import { hashPassword } from '../src/lib/auth.js';

/** Fresh in-memory Postgres + migrated schema + Express app. No network needed. */
export async function testContext({ mockUpstream = 'true' } = {}) {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  const config = {
    ...loadConfig({}),
    mockUpstream,
    upstreamBaseUrl: '',
    upstreamApiKey: '',
    jwtSecret: 'test-secret-for-vitest-only',
  };
  const app = createApp({ pool, config });
  return { pool, app, config };
}

export async function seedUser(pool, { email = 'owner@example.com', password = 's3cret!', role = 'admin' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role`,
    [email, hashPassword(password), role]
  );
  return { ...rows[0], password };
}
