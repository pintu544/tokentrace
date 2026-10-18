-- 007_plans: per-user billing plans + invoice hardening (Slice 4)
--
-- Plans are seeded here; Stripe test-mode product/price IDs are filled in by
-- the plans sync script (server/src/jobs/sync-plans.js) via an idempotent
-- lookup on metadata.tokentrace_plan. NULL Stripe IDs simply mean "not synced
-- to Stripe yet" — local billing math works without them.

CREATE TABLE IF NOT EXISTS plans (
  name TEXT PRIMARY KEY,
  price_cents INTEGER NOT NULL,
  included_tokens BIGINT NOT NULL,
  -- NUMERIC because the spec price $0.002/1K tokens = 0.2 cents/1K is fractional.
  -- (An earlier convention stored integer 20 here, which overcharged 100x.)
  overage_cents_per_1k NUMERIC NOT NULL,
  stripe_product_id TEXT,
  stripe_price_id TEXT
);

INSERT INTO plans (name, price_cents, included_tokens, overage_cents_per_1k)
VALUES
  ('starter', 1900, 1000000, 0.2),
  ('pro', 7900, 10000000, 0.2)
ON CONFLICT (name) DO NOTHING;

-- Per-user plan assignment (default starter). FK kept simple: plans are
-- seeded before users in practice; a missing plan name falls back to starter
-- in application code.
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_name TEXT NOT NULL DEFAULT 'starter';

-- Track metered tokens per invoice for the dashboard + demo.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS total_tokens BIGINT NOT NULL DEFAULT 0;

-- Idempotency guard for the nightly billing job: one invoice per user/period.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_user_period
  ON invoices (user_id, period_start);
