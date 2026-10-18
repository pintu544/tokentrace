import { apiFetch, fmt } from '@/lib/api';

function dollars(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

export default async function BillingPage() {
  const res = await apiFetch('billing/summary');
  const s = res.status === 200 ? res.data : null;

  if (!s) {
    return <p className="text-dim">Could not load billing summary — is the API running?</p>;
  }

  const pct = s.plan.included_tokens
    ? Math.min(100, Math.round((100 * s.period.used_tokens) / s.plan.included_tokens))
    : 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Billing</h1>

      <div className="card border-amber-900/60">
        <p className="text-sm text-amber-200/90">
          <span className="font-semibold">Slice 4 preview.</span> Usage metering below is live;
          real Stripe invoicing (invoice items, webhooks, invoice history) lands in Slice 4.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-dim">Current plan</p>
          <p className="text-2xl font-bold text-white mt-1 capitalize">{s.plan.name}</p>
          <p className="text-sm text-dim mt-1">
            {dollars(s.plan.price_cents)}/mo · {fmt(s.plan.included_tokens)} tokens included ·{' '}
            {dollars(s.plan.overage_cents_per_1k)}/1K overage
          </p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-dim">Overage estimate this period</p>
          <p className="text-2xl font-bold text-white mt-1">{dollars(s.period.overage_estimate_cents)}</p>
          <p className="text-sm text-dim mt-1">{fmt(s.period.overage_tokens)} tokens over included</p>
        </div>
      </div>

      <div className="card">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-semibold text-white">Usage this period</h2>
          <p className="text-sm text-dim tabular-nums">
            {fmt(s.period.used_tokens)} / {fmt(s.plan.included_tokens)} tokens
          </p>
        </div>
        <div className="h-3 bg-ink rounded-full overflow-hidden border border-line">
          <div
            className={`h-full rounded-full ${pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-400' : 'bg-sky-500'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-xs text-dim mt-2">
          Period started {new Date(s.period.start).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
        </p>
      </div>

      <div className="card">
        <h2 className="text-sm font-semibold text-white mb-2">Invoices</h2>
        {s.invoices.length === 0 ? (
          <p className="text-dim text-sm">No invoices yet — Stripe invoicing arrives in Slice 4.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Period</th>
                <th className="text-right">Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {s.invoices.map((inv) => (
                <tr key={inv.id}>
                  <td className="font-mono text-xs">{inv.stripe_invoice_id || `#${inv.id}`}</td>
                  <td className="text-xs">{inv.period_start} → {inv.period_end}</td>
                  <td className="text-right tabular-nums">{dollars(inv.amount_cents)}</td>
                  <td><span className="badge badge-viewer">{inv.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
