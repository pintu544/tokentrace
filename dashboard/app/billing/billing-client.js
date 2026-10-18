'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ConnectBillingButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  async function connect() {
    setBusy(true);
    setError('');
    const res = await fetch('/api/billing/customer', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.error?.message || 'Failed to connect billing');
      return;
    }
    router.refresh();
  }

  return (
    <div>
      <button onClick={connect} disabled={busy} className="btn">
        {busy ? 'Connecting…' : 'Connect billing'}
      </button>
      {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
      <p className="text-xs text-dim mt-2">
        Creates a Stripe test-mode customer linked to your account. No real charges.
      </p>
    </div>
  );
}
