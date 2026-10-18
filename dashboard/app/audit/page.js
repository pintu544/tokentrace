'use client';

import { useEffect, useState } from 'react';

const PAGE_SIZE = 25;

function fmtDate(iso) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function snippet(obj) {
  const s = JSON.stringify(obj);
  return s.length > 220 ? s.slice(0, 220) + '…' : s;
}

export default function AuditPage() {
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [filters, setFilters] = useState({ q: '', model: '', from: '', to: '', key_id: '' });
  const [page, setPage] = useState(0);

  async function load(p = page, f = filters) {
    const params = new URLSearchParams({ limit: PAGE_SIZE, offset: p * PAGE_SIZE });
    if (f.q) params.set('q', f.q);
    if (f.model) params.set('model', f.model);
    if (f.from) params.set('from', new Date(f.from).toISOString());
    if (f.to) params.set('to', new Date(f.to).toISOString());
    if (f.key_id) params.set('key_id', f.key_id);
    const res = await fetch(`/api/audit?${params}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error?.message || 'Failed to load audit log');
      return;
    }
    setRows(data.data);
    setTotal(data.total);
  }

  useEffect(() => {
    load(0, filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function search(e) {
    e.preventDefault();
    setPage(0);
    load(0, filters);
  }

  function set(f, v) {
    setFilters((prev) => ({ ...prev, [f]: v }));
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Audit Log</h1>
      <p className="text-sm text-dim -mt-4">Prompts and responses are stored PII-redacted.</p>

      {error && (
        <p className="text-sm text-red-400 bg-red-950/50 border border-red-900 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      <form onSubmit={search} className="card">
        <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <div>
            <label className="label">Search text</label>
            <input className="input" value={filters.q} onChange={(e) => set('q', e.target.value)} placeholder="keywords…" />
          </div>
          <div>
            <label className="label">Model</label>
            <input className="input" value={filters.model} onChange={(e) => set('model', e.target.value)} placeholder="gpt-4o" />
          </div>
          <div>
            <label className="label">From</label>
            <input className="input" type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} />
          </div>
          <div>
            <label className="label">To</label>
            <input className="input" type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} />
          </div>
          <div>
            <label className="label">Key ID</label>
            <input className="input" type="number" min="1" value={filters.key_id} onChange={(e) => set('key_id', e.target.value)} placeholder="optional" />
          </div>
        </div>
        <div className="mt-4">
          <button className="btn" type="submit">Search</button>
        </div>
      </form>

      <div className="card">
        {rows === null ? (
          <p className="text-dim text-sm">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-dim text-sm">No audit entries match.</p>
        ) : (
          <>
            <p className="text-xs text-dim mb-3">
              {total} entr{total === 1 ? 'y' : 'ies'} · page {page + 1} of {pages}
            </p>
            <table className="data">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Key</th>
                  <th>Model</th>
                  <th>Request (redacted)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <>
                    <tr key={r.id}>
                      <td className="text-xs whitespace-nowrap">{fmtDate(r.created_at)}</td>
                      <td className="text-xs text-dim">#{r.key_id}</td>
                      <td className="text-xs font-mono">{r.model}</td>
                      <td className="text-xs text-dim font-mono">{snippet(r.request_redacted)}</td>
                      <td className="text-right">
                        <button className="btn-ghost" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                          {expanded === r.id ? 'Hide' : 'Details'}
                        </button>
                      </td>
                    </tr>
                    {expanded === r.id && (
                      <tr key={`${r.id}-x`}>
                        <td colSpan={5} className="!pt-0">
                          <div className="grid md:grid-cols-2 gap-3">
                            <div>
                              <p className="label">Request (redacted)</p>
                              <pre className="code">{JSON.stringify(r.request_redacted, null, 2)}</pre>
                            </div>
                            <div>
                              <p className="label">Response (redacted)</p>
                              <pre className="code">{JSON.stringify(r.response_redacted, null, 2)}</pre>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
            <div className="flex items-center gap-3 mt-4">
              <button className="btn-ghost" disabled={page === 0} onClick={() => { const p = page - 1; setPage(p); load(p); }}>
                ← Prev
              </button>
              <button className="btn-ghost" disabled={page + 1 >= pages} onClick={() => { const p = page + 1; setPage(p); load(p); }}>
                Next →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
