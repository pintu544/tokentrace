-- 006_dashboard: last-used tracking on API keys + plan fields for billing summary (Slice 3)
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

ALTER TABLE settings ADD COLUMN IF NOT EXISTS plan_name TEXT NOT NULL DEFAULT 'starter';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS plan_price_cents INTEGER NOT NULL DEFAULT 1900;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS plan_included_tokens BIGINT NOT NULL DEFAULT 1000000;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS plan_overage_cents_per_1k INTEGER NOT NULL DEFAULT 20;
-- plan_overage_cents_per_1k = 20 means $0.002 per 1K tokens (20 cents / 1000 tokens)

-- Backfill pre-existing settings rows (ADD COLUMN DEFAULT does not reliably
-- backfill on every Postgres-compatible engine).
UPDATE settings
SET plan_name = COALESCE(plan_name, 'starter'),
    plan_price_cents = COALESCE(plan_price_cents, 1900),
    plan_included_tokens = COALESCE(plan_included_tokens, 1000000),
    plan_overage_cents_per_1k = COALESCE(plan_overage_cents_per_1k, 20);
