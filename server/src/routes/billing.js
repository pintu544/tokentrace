import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

/**
 * Billing summary (Slice 3: computed from local settings + usage; no Stripe yet).
 *   GET /api/billing/summary
 *
 * Returns the plan, this month's metered usage vs included tokens, and the
 * overage estimate. Slice 4 wires real Stripe (invoice items, webhooks,
 * invoice history) — until then `invoices` is empty and `stripe` is null.
 */
export function billingRouter({ pool, config }) {
  const router = Router();
  router.use(requireAuth({ jwtSecret: config.jwtSecret }));

  router.get('/api/billing/summary', async (req, res) => {
    const { rows: settingsRows } = await pool.query(
      `SELECT plan_name, plan_price_cents, plan_included_tokens, plan_overage_cents_per_1k
       FROM settings WHERE id = 1`
    );
    const s = settingsRows[0];

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const { rows: usageRows } = await pool.query(
      `SELECT COALESCE(SUM(total_tokens), 0)::bigint AS tokens
       FROM usage_events WHERE created_at >= $1`,
      [monthStart.toISOString()]
    );
    const usedTokens = Number(usageRows[0].tokens);
    const included = Number(s.plan_included_tokens);
    const overageTokens = Math.max(0, usedTokens - included);
    // plan_overage_cents_per_1k = cents per 1000 tokens, e.g. 20 = $0.002/1K.
    const overageCents = Math.ceil((overageTokens / 1000) * Number(s.plan_overage_cents_per_1k));

    return res.json({
      plan: {
        name: s.plan_name,
        price_cents: s.plan_price_cents,
        included_tokens: included,
        overage_cents_per_1k: Number(s.plan_overage_cents_per_1k),
      },
      period: {
        start: monthStart.toISOString(),
        used_tokens: usedTokens,
        overage_tokens: overageTokens,
        overage_estimate_cents: overageCents,
      },
      // Slice 4: real Stripe customer + invoice history land here.
      stripe: null,
      invoices: [],
    });
  });

  return router;
}
