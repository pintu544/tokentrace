/**
 * Seed an admin user. Usage:
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=secret npm run seed
 * If ADMIN_PASSWORD is unset, a random one is generated and printed once.
 */
import 'dotenv/config';
import { randomBytes, scryptSync } from 'node:crypto';
import { createPool, migrate } from './db.js';

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

const email = process.env.ADMIN_EMAIL || 'admin@tokentrace.local';
const password = process.env.ADMIN_PASSWORD || randomBytes(12).toString('hex');

const pool = createPool();
await migrate(pool);
const { rows } = await pool.query(
  `INSERT INTO users (email, password_hash, role)
   SELECT $1, $2, 'admin'
   WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = $1)
   RETURNING id, email`,
  [email, hashPassword(password)]
);
if (rows.length) {
  console.log(`Seeded admin user: ${rows[0].email}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log(`Generated password (shown once): ${password}`);
  }
} else {
  console.log(`Admin user ${email} already exists — nothing to do.`);
}
await pool.end();
