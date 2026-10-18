import { Router } from 'express';
import { getStripeClient } from '../lib/stripe.js';

/**
 * Stripe webhooks (Slice 4).
 *   POST /api/webhooks/stripe
 *
 * MUST be mounted with express.raw({ type: 'application/json' }) BEFORE the
 * global express.json() middleware — signature verification needs the exact
 * raw bytes. See app.js.
 *
 * Handled events:
 *   invoice.paid          → invoices.status = 'paid'
 *   invoice.payment_failed → invoices.status = 'payment_failed'
 * All other event types are acknowledged and ignored.
 *
 * The webhook secret comes from `stripe listen` or the Stripe dashboard
 * (Developers → Webhooks) as STRIPE_WEBHOOK_SECRET. 400 on bad signature.
 */
export function webhookRouter({ pool, config, stripeClient } = {}) {
  const router = Router();

  router.post('/api/webhooks/stripe', async (req, res) => {
    const stripe = stripeClient || getStripeClient(config);
    if (!stripe) {
      return res.status(503).json({ error: { message: 'Stripe not configured' } });
    }
    if (!config.stripeWebhookSecret) {
      return res.status(503).json({ error: { message: 'Webhook secret not configured' } });
    }
    const sig = req.get('stripe-signature');
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, config.stripeWebhookSecret);
    } catch {
      return res.status(400).json({ error: { message: 'Invalid webhook signature' } });
    }

    if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
      const stripeInvoiceId = event.data?.object?.id;
      const status = event.type === 'invoice.paid' ? 'paid' : 'payment_failed';
      if (stripeInvoiceId) {
        await pool.query(`UPDATE invoices SET status = $2 WHERE stripe_invoice_id = $1`, [
          stripeInvoiceId,
          status,
        ]);
      }
    }
    return res.json({ received: true });
  });

  return router;
}
