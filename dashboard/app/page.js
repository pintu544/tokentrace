import { apiFetch, fmt } from '@/lib/api';

function StatCard({ label, value, sub }) {
  return (
    <div className="card">
      <p className="text-xs uppercase tracking-wide text-dim">{label}</p>
      <p className="text-3xl font-bold text-white mt-1 tabular-nums">{value}</p>
      {sub && <p className="text-xs text-dim mt-1">{sub}</p>}
    </div>
  );
}

/** Minimal inline-SVG bar chart — no chart library needed. */
function DailyChart({ days }) {
  const max = Math.max(1, ...days.map((d) => d.tokens));
  const W = 900;
  const H = 180;
  const pad = 8;
  const bw = (W - pad * 2) / days.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Daily token usage">
      {days.map((d, i) => {
        const h = Math.max(2, ((H - 40) * d.tokens) / max);
        const x = pad + i * bw + 2;
        const y = H - 24 - h;
        return (
          <g key={d.date}>
            <title>{`${d.date}: ${fmt(d.tokens)} tokens, ${d.requests} requests`}</title>
            <rect
              x={x}
              y={y}
              width={Math.max(1, bw - 4)}
              height={h}
              rx="3"
              className="fill-sky-600 hover:fill-sky-400"
            />
          </g>
        );
      })}
      <text x={pad} y={H - 6} className="fill-slate-500" fontSize="11">
        {days[0]?.date}
      </text>
      <text x={W - pad} y={H - 6} textAnchor="end" className="fill-slate-500" fontSize="11">
        {days[days.length - 1]?.date}
      </text>
    </svg>
  );
}

export default async function OverviewPage() {
  const [overview, daily] = await Promise.all([
    apiFetch('stats/overview'),
    apiFetch('stats/daily?days=30'),
  ]);
  const o = overview.status === 200 ? overview.data : null;
  const days = daily.status === 200 ? daily.data.data : [];

  if (!o) {
    return <p className="text-dim">Could not load usage stats — is the API running?</p>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Overview</h1>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Tokens today" value={fmt(o.today.tokens)} sub={`${fmt(o.today.requests)} requests`} />
        <StatCard label="Tokens this month" value={fmt(o.month.tokens)} sub={`${fmt(o.month.requests)} requests`} />
        <StatCard label="Active keys" value={o.topKeys.length} sub="with usage this month" />
        <StatCard
          label="Top key share"
          value={o.month.tokens ? `${Math.round((100 * (o.topKeys[0]?.tokens || 0)) / o.month.tokens)}%` : '—'}
          sub={o.topKeys[0]?.name || 'no usage yet'}
        />
      </div>

      <div className="card">
        <h2 className="text-sm font-semibold text-white mb-4">Token usage — last 30 days</h2>
        {days.length ? <DailyChart days={days} /> : <p className="text-dim text-sm">No data yet.</p>}
      </div>

      <div className="card">
        <h2 className="text-sm font-semibold text-white mb-2">Top keys this month</h2>
        {o.topKeys.length ? (
          <table className="data">
            <thead>
              <tr>
                <th>Key</th>
                <th>Name</th>
                <th className="text-right">Tokens</th>
                <th className="text-right">Requests</th>
              </tr>
            </thead>
            <tbody>
              {o.topKeys.map((k) => (
                <tr key={k.id}>
                  <td className="font-mono text-xs">{k.key_prefix}…</td>
                  <td>{k.name}</td>
                  <td className="text-right tabular-nums">{fmt(k.tokens)}</td>
                  <td className="text-right tabular-nums">{fmt(k.requests)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-dim text-sm">No usage recorded yet — issue a key and send traffic through the proxy.</p>
        )}
      </div>
    </div>
  );
}
