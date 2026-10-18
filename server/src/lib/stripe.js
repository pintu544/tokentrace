/**
 * Stripe test-mode integration (Slice 4).
 *
 * All Stripe access goes through `getStripeClient(config, { client })`:
 *  - production path: builds the real `stripe` SDK client from
 *    config.stripeSecretKey (test-mode key from env — NEVER committed).
 *  - test path: pass `{ client: mockStripe }` to inject a stub; no network.
 *  - disabled path: returns null when no key is configured — callers must
 *    degrade gracefully (billing endpoints return 503 with a clear message).
 *
 * The key value is never logged, printed, or included in error messages.
 */
import Stripe from 'stripe';

export const PLAN_DEFS = [
  // overage_cents_per_1k: spec price is $0.002/1K tokens = 0.2 cents per 1K.
  { name: 'starter', price_cents: 1900, included_tokens: 1_000_000, overage_cents_per_1k: 0.2 },
  { name: 'pro', price_cents: 7900, included_tokens: 10_000_000, overage_cents_per_1k: 0.2 },
];

/**
 * Pure billing math — unit-tested, no Stripe involved.
 * overage_cents_per_1k is fractional (NUMERIC in DB), so the raw product is
 * rounded to 9 decimals before ceil to kill IEEE754 epsilon noise without
 * touching genuine fractions (smallest real charge: 1 token → 0.0002c).
 */
export function computeOverage({ usedTokens, includedTokens, overageCentsPer1k }) {
  const overageTokens = Math.max(0, usedTokens - includedTokens);
  const raw = (overageTokens / 1000) * Number(overageCentsPer1k);
  const overageCents = Math.ceil(Number(raw.toFixed(9)));
  return { overageTokens, overageCents };
}

export function getStripeClient(config, { client } = {}) {
  if (client) return client;
  if (!config?.stripeSecretKey) return null;
  return new Stripe(config.stripeSecretKey, { apiVersion: '2025-08-27.basil' });
}

/**
 * Idempotently ensure each plan has a Stripe test-mode Product + recurring
 * Price. Looks up existing products by metadata.tokentrace_plan so re-runs
 * are safe. Persists the Stripe IDs into the plans table.
 */
export async function syncPlanProducts(pool, stripe) {
  const { data: existing } = await stripe.products.list({ limit: 100 });
  const synced = [];
  for (const def of PLAN_DEFS) {
    let product = existing.find((p) => p.metadata?.tokentrace_plan === def.name);
    if (!product) {
      product = await stripe.products.create({
        name: `TokenTrace ${def.name[0].toUpperCase()}${def.name.slice(1)}`,
        metadata: { tokentrace_plan: def.name },
      });
    }
    let priceId = null;
    const { data: prices } = await stripe.prices.list({ product: product.id, limit: 10 });
    const match = prices.find(
      (pr) => pr.unit_amount === def.price_cents && pr.recurring?.interval === 'month'
    );
    if (match) {
      priceId = match.id;
    } else {
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: def.price_cents,
        currency: 'usd',
        recurring: { interval: 'month' },
        metadata: { tokentrace_plan: def.name },
      });
      priceId = price.id;
    }
    await pool.query(
      `UPDATE plans SET stripe_product_id = $2, stripe_price_id = $3 WHERE name = $1`,
      [def.name, product.id, priceId]
    );
    synced.push({ name: def.name, product_id: product.id, price_id: priceId });
  }
  return synced;
}

export async function getUserPlan(pool, userId) {
  const { rows } = await pool.query(
    `SELECT p.name, p.price_cents, p.included_tokens, p.overage_cents_per_1k,
            p.stripe_product_id, p.stripe_price_id
     FROM users u JOIN plans p ON p.name = u.plan_name
     WHERE u.id = $1`,
    [userId]
  );
  if (rows.length) return rows[0];
  // Fallback: plan_name points nowhere (shouldn't happen) → starter def.
  const { rows: srows } = await pool.query(`SELECT * FROM plans WHERE name = 'starter'`);
  return srows[0];
}

/** Sum of total_tokens across the user's keys since periodStart. */
export async function getUserUsage(pool, userId, periodStart) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(e.total_tokens), 0)::bigint AS tokens
     FROM usage_events e JOIN api_keys k ON k.id = e.key_id
     WHERE k.user_id = $1 AND e.created_at >= $2`,
    [userId, periodStart.toISOString()]
  );
  return Number(rows[0].tokens);
}

export function currentPeriod() {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  return { start, end };
}
