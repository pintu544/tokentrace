/**
 * Nightly billing job: metered usage → Stripe test-mode invoice items → invoice.
 *
 * Importable/testable: `runBilling(pool, { stripe, dryRun })` returns a list of
 * per-user results. Runnable as a script: `node src/jobs/billing.js [--dry-run]`
 * (needs DATABASE_URL + STRIPE_SECRET_KEY). Schedule nightly via cron/Render
 * cron job in production.
 *
 * Idempotent: one invoice row per (user_id, period_start) — a second run in
 * the same month skips users already invoiced. Users with zero overage still
 * get a $0 informational invoice so the dashboard history is complete.
 *
 * Test mode only — no real money moves. The Stripe key value is never logged.
 */
import { fileURLToPath } from 'node:url';
import { createPool } from '../db.js';
import { loadConfig } from '../app.js';
import {
  computeOverage,
  currentPeriod,
  getStripeClient,
  getUserPlan,
  getUserUsage,
} from '../lib/stripe.js';

export async function runBilling(pool, { stripe = null, dryRun = false } = {}) {
  if (!dryRun && !stripe) {
    throw new Error('billing: no Stripe client — set STRIPE_SECRET_KEY or use --dry-run');
  }
  const { start, end } = currentPeriod();
  const { rows: customers } = await pool.query(
    `SELECT c.user_id, c.stripe_customer_id, u.email, u.plan_name
     FROM stripe_customers c JOIN users u ON u.id = c.user_id`
  );
  const results = [];
  for (const c of customers) {
    const existing = await pool.query(
      `SELECT id FROM invoices WHERE user_id = $1 AND period_start = $2`,
      [c.user_id, start.toISOString()]
    );
    if (existing.rows.length) {
      results.push({ user_id: c.user_id, email: c.email, skipped: 'already-invoiced' });
      continue;
    }
    const plan = await getUserPlan(pool, c.user_id);
    const usedTokens = await getUserUsage(pool, c.user_id, start);
    const { overageTokens, overageCents } = computeOverage({
      usedTokens,
      includedTokens: Number(plan.included_tokens),
      overageCentsPer1k: Number(plan.overage_cents_per_1k),
    });

    if (dryRun) {
      results.push({
        user_id: c.user_id,
        email: c.email,
        plan: plan.name,
        used_tokens: usedTokens,
        overage_tokens: overageTokens,
        overage_cents: overageCents,
        dry_run: true,
      });
      continue;
    }

    // Overage-only invoice items; the plan's recurring fee is represented by
    // the Stripe Price (subscriptions are a production concern, out of scope).
    if (overageCents > 0) {
      await stripe.invoiceItems.create({
        customer: c.stripe_customer_id,
        amount: overageCents,
        currency: 'usd',
        description: `TokenTrace overage: ${overageTokens.toLocaleString('en-US')} tokens beyond ${Number(plan.included_tokens).toLocaleString('en-US')} included (${plan.name} plan)`,        metadata: { tokentrace_user_id: String(c.user_id), tokentrace_plan: plan.name },
      });
    }
    const draft = await stripe.invoices.create({
      customer: c.stripe_customer_id,
      collection_method: 'send_invoice',
      days_until_due: 7,
      metadata: {
        tokentrace_user_id: String(c.user_id),
        tokentrace_plan: plan.name,
        period_start: start.toISOString(),
      },
    });
    const finalized = await stripe.invoices.finalizeInvoice(draft.id);
    await pool.query(
      `INSERT INTO invoices
         (user_id, stripe_invoice_id, amount_cents, status, period_start, period_end, total_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        c.user_id,
        finalized.id,
        overageCents,
        finalized.status || 'open',
        start.toISOString(),
        end.toISOString(),
        usedTokens,
      ]
    );
    results.push({
      user_id: c.user_id,
      email: c.email,
      plan: plan.name,
      used_tokens: usedTokens,
      overage_tokens: overageTokens,
      overage_cents: overageCents,
      stripe_invoice_id: finalized.id,
      status: finalized.status,
    });
  }
  return results;
}

const invokedAsScript =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedAsScript) {
  const dryRun = process.argv.includes('--dry-run');
  const config = loadConfig(process.env);
  const stripe = dryRun ? null : getStripeClient(config);
  const pool = createPool();
  try {
    const results = await runBilling(pool, { stripe, dryRun });
    for (const r of results) {
      console.log(
        `billing: user=${r.user_id} plan=${r.plan || '?'} used=${r.used_tokens ?? '?'} ` +
          `overage=${r.overage_tokens ?? '?'}t/${r.overage_cents ?? '?'}c` +
          (r.skipped ? ` skipped=${r.skipped}` : '') +
          (r.stripe_invoice_id ? ` invoice=${r.stripe_invoice_id} status=${r.status}` : '') +
          (r.dry_run ? ' (dry-run)' : '')
      );
    }
  } finally {
    await pool.end();
  }
}
