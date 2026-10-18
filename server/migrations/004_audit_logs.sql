-- 004_audit_logs: PII-redacted request/response per proxied call (written from Slice 2)
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  request_redacted JSONB NOT NULL,
  response_redacted JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_key_time ON audit_logs(key_id, created_at);
-- NOTE: a GIN index for full-text search is deferred to Slice 5 hardening
-- (kept out here for pg-mem compatibility in tests); v1 search uses ILIKE.
