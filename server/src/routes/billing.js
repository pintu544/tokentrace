import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  computeOverage,
  currentPeriod,
  getStripeClient,
  getUserPlan,
  getUserUsage,
} from '../lib/stripe.js';

/**
 * Billing API (Slice 4: real Stripe test-mode wiring).
 *
 *   GET  /api/billing/summary    — caller's plan, this month's usage vs
 *                                  included tokens, overage estimate, Stripe
 *                                  customer link, invoice history.
 *   GET  /api/billing/invoices   — caller's invoices, newest first.
 *   POST /api/billing/customer   — admin only: create the caller's Stripe
 *                                  test-mode customer and store the mapping.
 *                                  409 when a customer already exists,
 *                                  503 when Stripe is not configured.
 *
 * Usage and plans are per-user (users.plan_name → plans). Viewer role is
 * read-only: customer creation requires admin.
 */
export function billingRouter({ pool, config, stripeClient } = {}) {
  const router = Router();
  router.use(requireAuth({ jwtSecret: config.jwtSecret }));

  async function summaryFor(userId) {
    const plan = await getUserPlan(pool, userId);
    const { start } = currentPeriod();
    const usedTokens = await getUserUsage(pool, userId, start);
    const included = Number(plan.included_tokens);
    const { overageTokens, overageCents } = computeOverage({
      usedTokens,
      includedTokens: included,
      overageCentsPer1k: Number(plan.overage_cents_per_1k),
    });
    const { rows: custRows } = await pool.query(
      `SELECT stripe_customer_id FROM stripe_customers WHERE user_id = $1`,
      [userId]
    );
    const { rows: invRows } = await pool.query(
      `SELECT id, stripe_invoice_id, amount_cents, status, total_tokens,
              period_start, period_end, created_at
       FROM invoices WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [userId]
    );
    return {
      plan: {
        name: plan.name,
        price_cents: plan.price_cents,
        included_tokens: included,
        overage_cents_per_1k: Number(plan.overage_cents_per_1k),
        stripe_price_id: plan.stripe_price_id || null,
      },
      period: {
        start: start.toISOString(),
        used_tokens: usedTokens,
        overage_tokens: overageTokens,
        overage_estimate_cents: overageCents,
      },
      stripe_customer: custRows[0]?.stripe_customer_id || null,
      invoices: invRows,
    };
  }

  router.get('/api/billing/summary', async (req, res) => {
    return res.json(await summaryFor(req.user.id));
  });

  router.get('/api/billing/invoices', async (req, res) => {
    const s = await summaryFor(req.user.id);
    return res.json({ invoices: s.invoices });
  });

  router.post('/api/billing/customer', requireRole('admin'), async (req, res) => {
    const stripe = stripeClient || getStripeClient(config);
    if (!stripe) {
      return res.status(503).json({ error: { message: 'Stripe not configured' } });
    }
    const { rows: existing } = await pool.query(
      `SELECT stripe_customer_id FROM stripe_customers WHERE user_id = $1`,
      [req.user.id]
    );
    if (existing.length) {
      return res
        .status(409)
        .json({ error: { message: 'Billing customer already connected' } });
    }
    const customer = await stripe.customers.create({
      email: req.user.email,
      metadata: { tokentrace_user_id: String(req.user.id) },
    });
    await pool.query(
      `INSERT INTO stripe_customers (user_id, stripe_customer_id) VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [req.user.id, customer.id]
    );
    return res.status(201).json({ stripe_customer_id: customer.id });
  });

  return router;
}
