import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { testContext, seedUser } from './helpers.js';
import { computeOverage, currentPeriod, syncPlanProducts } from '../src/lib/stripe.js';
import { runBilling } from '../src/jobs/billing.js';

/** Recording stub for the Stripe SDK — no network. */
function mockStripe() {
  const calls = [];
  return {
    calls,
    customers: {
      create: async (p) => {
        calls.push(['customers.create', p]);
        return { id: 'cus_mock1', ...p };
      },
    },
    invoiceItems: {
      create: async (p) => {
        calls.push(['invoiceItems.create', p]);
        return { id: 'ii_mock1' };
      },
    },
    invoices: {
      create: async (p) => {
        calls.push(['invoices.create', p]);
        return { id: 'in_mock1', status: 'draft' };
      },
      finalizeInvoice: async (id) => {
        calls.push(['invoices.finalizeInvoice', id]);
        return { id, status: 'open' };
      },
    },
    products: {
      list: async () => {
        calls.push(['products.list']);
        return { data: [] };
      },
      create: async (p) => {
        calls.push(['products.create', p]);
        return { id: `prod_mock_${p.metadata.tokentrace_plan}`, metadata: p.metadata };
      },
    },
    prices: {
      list: async () => {
        calls.push(['prices.list']);
        return { data: [] };
      },
      create: async (p) => {
        calls.push(['prices.create', p]);
        return { id: `price_mock_${p.metadata.tokentrace_plan}`, unit_amount: p.unit_amount, recurring: p.recurring };
      },
    },
  };
}

async function seedUsage(pool, userId, totalTokens, { model = 'rest:api' } = {}) {
  const { rows: [key] } = await pool.query(
    `INSERT INTO api_keys (key_hash, key_prefix, name, user_id)
     VALUES ($1, 'tt_live_t', 'test-key', $2) RETURNING id`,
    [`hash-${userId}-${Math.random()}`, userId]
  );
  await pool.query(
    `INSERT INTO usage_events (key_id, model, prompt_tokens, completion_tokens, total_tokens)
     VALUES ($1, $2, $3, 0, $3)`,
    [key.id, model, totalTokens]
  );
}

async function loginAs(app, email, password) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.token;
}
const authHeader = (token) => ({ Authorization: `Bearer ${token}` });

describe('computeOverage', () => {
  it('returns zero overage when under the included amount', () => {
    expect(computeOverage({ usedTokens: 500_000, includedTokens: 1_000_000, overageCentsPer1k: 20 }))
      .toEqual({ overageTokens: 0, overageCents: 0 });
  });
  it('returns zero overage exactly at the boundary', () => {
    expect(computeOverage({ usedTokens: 1_000_000, includedTokens: 1_000_000, overageCentsPer1k: 20 }))
      .toEqual({ overageTokens: 0, overageCents: 0 });
  });
  it('computes overage at $0.002/1K tokens', () => {
    // 2.5M used - 1M included = 1.5M over → 1500 × $0.002 = $3.00 = 300c
    expect(computeOverage({ usedTokens: 2_500_000, includedTokens: 1_000_000, overageCentsPer1k: 0.2 }))
      .toEqual({ overageTokens: 1_500_000, overageCents: 300 });
  });
  it('rounds partial 1K blocks up (ceil)', () => {
    // 1 token over → ceil(0.0002c) = 1c
    expect(computeOverage({ usedTokens: 1_000_001, includedTokens: 1_000_000, overageCentsPer1k: 0.2 }))
      .toEqual({ overageTokens: 1, overageCents: 1 });
  });
});

describe('billing job (mock Stripe)', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await testContext();
  });

  it('dry-run computes without any Stripe calls', async () => {
    const user = await seedUser(ctx.pool, { email: 'dry@example.com' });
    await ctx.pool.query(
      `INSERT INTO stripe_customers (user_id, stripe_customer_id) VALUES ($1, 'cus_dry')`,
      [user.id]
    );
    await seedUsage(ctx.pool, user.id, 2_500_000);
    const stripe = mockStripe();
    const results = await runBilling(ctx.pool, { stripe, dryRun: true });
    expect(stripe.calls).toEqual([]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      email: 'dry@example.com',
      plan: 'starter',
      used_tokens: 2_500_000,
      overage_tokens: 1_500_000,
      overage_cents: 300,
      dry_run: true,
    });
  });

  it('creates invoice items + invoice for overage, stores the row', async () => {
    const user = await seedUser(ctx.pool, { email: 'bill@example.com' });
    await ctx.pool.query(
      `INSERT INTO stripe_customers (user_id, stripe_customer_id) VALUES ($1, 'cus_bill')`,
      [user.id]
    );
    await seedUsage(ctx.pool, user.id, 2_500_000);
    const stripe = mockStripe();
    const results = await runBilling(ctx.pool, { stripe, dryRun: false });

    const kinds = stripe.calls.map((c) => c[0]);
    expect(kinds).toEqual(['invoiceItems.create', 'invoices.create', 'invoices.finalizeInvoice']);
    expect(stripe.calls[0][1].amount).toBe(300);
    expect(stripe.calls[0][1].customer).toBe('cus_bill');
    expect(results[0]).toMatchObject({ stripe_invoice_id: 'in_mock1', status: 'open' });

    const { rows } = await ctx.pool.query(`SELECT * FROM invoices WHERE user_id = $1`, [user.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stripe_invoice_id: 'in_mock1',
      amount_cents: 300,
      status: 'open',
    });
    expect(Number(rows[0].total_tokens)).toBe(2500000);
  });

  it('creates a $0 invoice when there is no overage', async () => {
    const user = await seedUser(ctx.pool, { email: 'free@example.com' });
    await ctx.pool.query(
      `INSERT INTO stripe_customers (user_id, stripe_customer_id) VALUES ($1, 'cus_free')`,
      [user.id]
    );
    await seedUsage(ctx.pool, user.id, 100);
    const stripe = mockStripe();
    await runBilling(ctx.pool, { stripe, dryRun: false });
    const kinds = stripe.calls.map((c) => c[0]);
    expect(kinds).toEqual(['invoices.create', 'invoices.finalizeInvoice']);
    const { rows } = await ctx.pool.query(`SELECT amount_cents FROM invoices WHERE user_id = $1`, [user.id]);
    expect(rows[0].amount_cents).toBe(0);
  });

  it('is idempotent: second run in the same period skips', async () => {
    const user = await seedUser(ctx.pool, { email: 'idem@example.com' });
    await ctx.pool.query(
      `INSERT INTO stripe_customers (user_id, stripe_customer_id) VALUES ($1, 'cus_idem')`,
      [user.id]
    );
    await seedUsage(ctx.pool, user.id, 2_500_000);
    const stripe = mockStripe();
    await runBilling(ctx.pool, { stripe, dryRun: false });
    const firstCallCount = stripe.calls.length;
    const results = await runBilling(ctx.pool, { stripe, dryRun: false });
    expect(stripe.calls.length).toBe(firstCallCount);
    expect(results[0].skipped).toBe('already-invoiced');
  });

  it('throws without a Stripe client when not a dry run', async () => {
    await expect(runBilling(ctx.pool, { stripe: null, dryRun: false })).rejects.toThrow(
      /no Stripe client/
    );
  });
});

describe('POST /api/billing/customer', () => {
  it('creates a customer for admins, 409 on repeat, 403 for viewers', async () => {
    const stripe = mockStripe();
    const ctx = await testContext();
    const { app } = ctx;
    // inject the mock client via a fresh app instance
    const { createApp } = await import('../src/app.js');
    const appWithStripe = createApp({ pool: ctx.pool, config: ctx.config, stripeClient: stripe });

    const admin = await seedUser(ctx.pool, { email: 'admin@example.com', password: 'adminpw', role: 'admin' });
    const viewer = await seedUser(ctx.pool, { email: 'viewer@example.com', password: 'viewerpw', role: 'viewer' });
    const adminToken = await loginAs(appWithStripe, 'admin@example.com', 'adminpw');
    const viewerToken = await loginAs(appWithStripe, 'viewer@example.com', 'viewerpw');

    const res = await request(appWithStripe)
      .post('/api/billing/customer')
      .set(authHeader(adminToken));
    expect(res.status).toBe(201);
    expect(res.body.stripe_customer_id).toBe('cus_mock1');
    const { rows } = await ctx.pool.query(`SELECT * FROM stripe_customers WHERE user_id = $1`, [admin.id]);
    expect(rows[0].stripe_customer_id).toBe('cus_mock1');

    const dup = await request(appWithStripe)
      .post('/api/billing/customer')
      .set(authHeader(adminToken));
    expect(dup.status).toBe(409);

    const forbidden = await request(appWithStripe)
      .post('/api/billing/customer')
      .set(authHeader(viewerToken));
    expect(forbidden.status).toBe(403);

    const unauth = await request(appWithStripe).post('/api/billing/customer');
    expect(unauth.status).toBe(401);
  });

  it('returns 503 when Stripe is not configured', async () => {
    const ctx = await testContext(); // config.stripeSecretKey is '' → null client
    await seedUser(ctx.pool, { email: 'admin@example.com', password: 'adminpw', role: 'admin' });
    const token = await loginAs(ctx.app, 'admin@example.com', 'adminpw');
    const res = await request(ctx.app).post('/api/billing/customer').set(authHeader(token));
    expect(res.status).toBe(503);
  });
});

describe('GET /api/billing/summary', () => {
  it('is scoped to the caller: plan, usage, customer, invoices', async () => {
    const stripe = mockStripe();
    const { createApp } = await import('../src/app.js');
    const ctx = await testContext();
    const app = createApp({ pool: ctx.pool, config: ctx.config, stripeClient: stripe });
    const user = await seedUser(ctx.pool, { email: 'u@example.com', password: 'pw12345' });
    await seedUsage(ctx.pool, user.id, 2_500_000);
    const token = await loginAs(app, 'u@example.com', 'pw12345');

    let res = await request(app).get('/api/billing/summary').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.plan.name).toBe('starter');
    expect(res.body.period.used_tokens).toBe(2500000);
    expect(res.body.period.overage_estimate_cents).toBe(300);
    expect(res.body.stripe_customer).toBeNull();
    expect(res.body.invoices).toEqual([]);

    // connect billing → summary reflects the customer
    await request(app).post('/api/billing/customer').set(authHeader(token)).expect(201);
    res = await request(app).get('/api/billing/summary').set(authHeader(token));
    expect(res.body.stripe_customer).toBe('cus_mock1');
  });
});

describe('POST /api/webhooks/stripe', () => {
  const secret = 'whsec_test123';
  const realStripe = new Stripe('sk_test_mock');
  const payload = JSON.stringify({
    id: 'evt_test1',
    object: 'event',
    type: 'invoice.paid',
    data: { object: { id: 'in_mock1', object: 'invoice' } },
  });

  async function setup() {
    const ctx = await testContext();
    ctx.config.stripeWebhookSecret = secret;
    const { createApp } = await import('../src/app.js');
    // real webhooks utils work offline (pure HMAC); other SDK calls unused here
    const app = createApp({ pool: ctx.pool, config: ctx.config, stripeClient: realStripe });
    return { ctx, app };
  }

  function signedHeaders(body) {
    return {
      'stripe-signature': realStripe.webhooks.generateTestHeaderString({ payload: body, secret }),
      'Content-Type': 'application/json',
    };
  }

  it('rejects a bad signature with 400', async () => {
    const { app } = await setup();
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set({ 'stripe-signature': 't=123,v1=bad', 'Content-Type': 'application/json' })
      .send(payload);
    expect(res.status).toBe(400);
  });

  it('marks the invoice paid on invoice.paid', async () => {
    const { ctx, app } = await setup();
    const user = await seedUser(ctx.pool);
    await ctx.pool.query(
      `INSERT INTO invoices (user_id, stripe_invoice_id, amount_cents, status, period_start, period_end, total_tokens)
       VALUES ($1, 'in_mock1', 3000, 'open', now(), now(), 2500000)`,
      [user.id]
    );
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set(signedHeaders(payload))
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    const { rows } = await ctx.pool.query(`SELECT status FROM invoices WHERE stripe_invoice_id = 'in_mock1'`);
    expect(rows[0].status).toBe('paid');
  });

  it('marks the invoice payment_failed on invoice.payment_failed', async () => {
    const { ctx, app } = await setup();
    const user = await seedUser(ctx.pool);
    await ctx.pool.query(
      `INSERT INTO invoices (user_id, stripe_invoice_id, amount_cents, status, period_start, period_end, total_tokens)
       VALUES ($1, 'in_mock2', 100, 'open', now(), now(), 1100000)`,
      [user.id]
    );
    const failedPayload = JSON.stringify({
      id: 'evt_test2',
      object: 'event',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_mock2', object: 'invoice' } },
    });
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set(signedHeaders(failedPayload))
      .send(failedPayload);
    expect(res.status).toBe(200);
    const { rows } = await ctx.pool.query(`SELECT status FROM invoices WHERE stripe_invoice_id = 'in_mock2'`);
    expect(rows[0].status).toBe('payment_failed');
  });

  it('acknowledges unknown event types without touching invoices', async () => {
    const { ctx, app } = await setup();
    const otherPayload = JSON.stringify({
      id: 'evt_test3',
      object: 'event',
      type: 'customer.created',
      data: { object: { id: 'cus_x' } },
    });
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set(signedHeaders(otherPayload))
      .send(otherPayload);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });
});

describe('syncPlanProducts (mock Stripe)', () => {
  it('creates products + prices and stores the IDs', async () => {
    const ctx = await testContext();
    const stripe = mockStripe();
    const synced = await syncPlanProducts(ctx.pool, stripe);
    expect(synced.map((s) => s.name).sort()).toEqual(['pro', 'starter']);
    const { rows } = await ctx.pool.query(`SELECT name, stripe_product_id, stripe_price_id FROM plans ORDER BY name`);
    expect(rows[0].stripe_product_id).toBe('prod_mock_pro');
    expect(rows[0].stripe_price_id).toBe('price_mock_pro');
    expect(rows[1].stripe_product_id).toBe('prod_mock_starter');
    // re-run is idempotent-safe: with existing products it reuses them
    const stripe2 = mockStripe();
    stripe2.products.list = async () => ({
      data: [
        { id: 'prod_mock_starter', metadata: { tokentrace_plan: 'starter' } },
        { id: 'prod_mock_pro', metadata: { tokentrace_plan: 'pro' } },
      ],
    });
    stripe2.prices.list = async () => ({ data: [] });
    await syncPlanProducts(ctx.pool, stripe2);
    expect(stripe2.calls.map((c) => c[0])).not.toContain('products.create');
  });
});

describe('migration 007', () => {
  it('seeds starter + pro plans with the spec prices', async () => {
    const ctx = await testContext();
    const { rows } = await ctx.pool.query(`SELECT * FROM plans ORDER BY name`);
    expect(rows.map((r) => [r.name, r.price_cents, Number(r.included_tokens), Number(r.overage_cents_per_1k)])).toEqual([
      ['pro', 7900, 10000000, 0.2],
      ['starter', 1900, 1000000, 0.2],
    ]);
  });
});
