'use client';

import { useEffect, useState } from 'react';

function fmt(n) {
  return new Intl.NumberFormat('en-US').format(Number(n) || 0);
}

export function KeysClient({ role }) {
  const isAdmin = role === 'admin';
  const [keys, setKeys] = useState(null);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [quota, setQuota] = useState('1000000');
  const [rate, setRate] = useState('60');
  const [newKey, setNewKey] = useState(null); // show-once plaintext
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(null); // key id being quota-edited
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await fetch('/api/keys');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error?.message || 'Failed to load keys');
      return;
    }
    setKeys(data.data);
  }

  useEffect(() => {
    load();
  }, []);

  async function issue(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        monthlyQuotaTokens: Number(quota),
        rateLimitPerMin: Number(rate),
      }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.error?.message || 'Failed to issue key');
      return;
    }
    setNewKey(data.data);
    setName('');
    setShowForm(false);
    load();
  }

  async function revoke(id) {
    if (!confirm('Revoke this key? Existing integrations using it will break.')) return;
    const res = await fetch(`/api/keys/${id}/revoke`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error?.message || 'Failed to revoke');
      return;
    }
    load();
  }

  async function saveQuota(id) {
    const res = await fetch(`/api/keys/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        monthlyQuotaTokens: Number(editing.quota),
        rateLimitPerMin: Number(editing.rate),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error?.message || 'Failed to update');
      return;
    }
    setEditing(null);
    load();
  }

  function copyKey() {
    navigator.clipboard.writeText(newKey.key).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">API Keys</h1>
        {isAdmin && (
          <button className="btn" onClick={() => setShowForm((v) => !v)}>
            + Issue key
          </button>
        )}
      </div>

      {error && (
        <p className="text-sm text-red-400 bg-red-950/50 border border-red-900 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      {newKey && (
        <div className="card border-sky-800">
          <h2 className="text-sm font-semibold text-white mb-2">Key issued — copy it now, it won't be shown again</h2>
          <div className="flex items-center gap-3">
            <code className="font-mono text-sm bg-ink border border-line rounded-lg px-3 py-2 flex-1 break-all">
              {newKey.key}
            </code>
            <button className="btn-ghost" onClick={copyKey}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button className="btn-ghost" onClick={() => setNewKey(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {showForm && isAdmin && (
        <form onSubmit={issue} className="card space-y-4">
          <h2 className="text-sm font-semibold text-white">Issue a new API key</h2>
          <div className="grid sm:grid-cols-3 gap-4">
            <div>
              <label className="label">Name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="acme-corp" required />
            </div>
            <div>
              <label className="label">Monthly token quota</label>
              <input className="input" type="number" min="0" value={quota} onChange={(e) => setQuota(e.target.value)} />
            </div>
            <div>
              <label className="label">Rate limit / minute</label>
              <input className="input" type="number" min="1" value={rate} onChange={(e) => setRate(e.target.value)} />
            </div>
          </div>
          <button className="btn" disabled={busy} type="submit">
            {busy ? 'Issuing…' : 'Issue key'}
          </button>
        </form>
      )}

      <div className="card">
        {keys === null ? (
          <p className="text-dim text-sm">Loading…</p>
        ) : keys.length === 0 ? (
          <p className="text-dim text-sm">No keys yet.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Key</th>
                <th>Name</th>
                <th className="text-right">Quota/mo</th>
                <th className="text-right">Rate/min</th>
                <th>Last used</th>
                <th>Status</th>
                {isAdmin && <th />}
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td className="font-mono text-xs">{k.key_prefix}…</td>
                  <td>{k.name}</td>
                  <td className="text-right tabular-nums">
                    {editing?.id === k.id ? (
                      <input
                        className="input !w-32 text-right"
                        type="number"
                        min="0"
                        value={editing.quota}
                        onChange={(e) => setEditing({ ...editing, quota: e.target.value })}
                      />
                    ) : (
                      fmt(k.monthly_quota_tokens)
                    )}
                  </td>
                  <td className="text-right tabular-nums">
                    {editing?.id === k.id ? (
                      <input
                        className="input !w-20 text-right"
                        type="number"
                        min="1"
                        value={editing.rate}
                        onChange={(e) => setEditing({ ...editing, rate: e.target.value })}
                      />
                    ) : (
                      k.rate_limit_per_min
                    )}
                  </td>
                  <td className="text-xs text-dim">
                    {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}
                  </td>
                  <td>
                    {k.revoked_at ? (
                      <span className="badge badge-revoked">revoked</span>
                    ) : (
                      <span className="badge badge-live">live</span>
                    )}
                  </td>
                  {isAdmin && (
                    <td className="text-right whitespace-nowrap">
                      {editing?.id === k.id ? (
                        <>
                          <button className="btn-ghost mr-2" onClick={() => saveQuota(k.id)}>Save</button>
                          <button className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                        </>
                      ) : (
                        <>
                          {!k.revoked_at && (
                            <>
                              <button
                                className="btn-ghost mr-2"
                                onClick={() =>
                                  setEditing({ id: k.id, quota: k.monthly_quota_tokens, rate: k.rate_limit_per_min })
                                }
                              >
                                Quota
                              </button>
                              <button className="btn-danger" onClick={() => revoke(k.id)}>
                                Revoke
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!isAdmin && (
          <p className="text-xs text-dim mt-4">You're signed in as a viewer — key issuance and revocation require an admin.</p>
        )}
      </div>
    </div>
  );
}
