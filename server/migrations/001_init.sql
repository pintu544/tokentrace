-- 001_init: users, global settings
-- (schema_migrations tracking table is created by the migrate() bootstrap)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  retention_days INTEGER NOT NULL DEFAULT 30,
  upstream_base_url TEXT
);

INSERT INTO settings (id, retention_days)
SELECT 1, 30 WHERE NOT EXISTS (SELECT 1 FROM settings WHERE id = 1);
