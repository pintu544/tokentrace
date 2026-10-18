/**
 * Sync billing plans to Stripe test mode (idempotent).
 *
 * Creates/looks-up one Product + recurring monthly Price per plan
 * (metadata.tokentrace_plan = starter|pro) and stores the Stripe IDs in the
 * plans table. Safe to re-run: existing products/prices are reused.
 *
 * Usage: `npm run plans:sync` (needs DATABASE_URL + STRIPE_SECRET_KEY).
 * Test mode only — no real money moves. The key value is never logged.
 */
import { fileURLToPath } from 'node:url';
import { createPool } from '../db.js';
import { loadConfig } from '../app.js';
import { getStripeClient, syncPlanProducts } from '../lib/stripe.js';

const invokedAsScript =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedAsScript) {
  const config = loadConfig(process.env);
  const stripe = getStripeClient(config);
  if (!stripe) {
    console.error('plans:sync: STRIPE_SECRET_KEY is not set');
    process.exit(1);
  }
  const pool = createPool();
  try {
    const synced = await syncPlanProducts(pool, stripe);
    for (const s of synced) {
      console.log(`plans:sync: ${s.name} → product=${s.product_id} price=${s.price_id}`);
    }
  } finally {
    await pool.end();
  }
}
