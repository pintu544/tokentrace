import { Pool } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function createPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  return new Pool({ connectionString });
}

/**
 * Split a SQL script into individual statements. Respects single-quoted
 * strings, line comments, and dollar-quoted blocks.
 */
export function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  let inString = false;
  let inDollar = null;
  while (i < sql.length) {
    if (!inString && !inDollar && sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    const ch = sql[i];
    if (!inString && !inDollar && ch === "'") {
      inString = true;
      current += ch;
      i++;
      continue;
    }
    if (inString) {
      current += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          current += sql[i + 1];
          i += 2;
          continue;
        }
        inString = false;
      }
      i++;
      continue;
    }
    if (!inDollar && ch === '$') {
      const m = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z_0-9]*\$/);
      if (m) {
        inDollar = m[0];
        current += inDollar;
        i += inDollar.length;
        continue;
      }
    }
    if (inDollar && sql.startsWith(inDollar, i)) {
      current += inDollar;
      i += inDollar.length;
      inDollar = null;
      continue;
    }
    if (!inDollar && ch === ';') {
      statements.push(current);
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim()) statements.push(current);
  return statements.map((s) => s.trim()).filter(Boolean);
}

/** Apply any pending versioned migrations from server/migrations/*.sql, in order. */
export async function migrate(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const { rows } = await pool.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));

  const dir = join(here, '..', 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    // One statement per query: pg-mem's pg adapter cannot parse multi-statement
    // strings, and this also matches how most real migration runners behave.
    for (const stmt of splitStatements(sql)) {
      await pool.query(stmt);
    }
    await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
  }
}
