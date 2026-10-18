-- 003_usage_events: one row per proxied call with token counts
CREATE TABLE IF NOT EXISTS usage_events (
  id SERIAL PRIMARY KEY,
  key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_events_key_time ON usage_events(key_id, created_at);
