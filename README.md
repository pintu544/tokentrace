# TokenTrace — meter, audit, and bill every AI API call

A drop-in proxy + dashboard for AI API usage. Route your OpenAI-compatible chat-completion
calls through TokenTrace with a per-customer API key; it forwards to your upstream LLM while
metering tokens per key, keeping a compliance-ready audit trail, enforcing quotas, and
turning usage into Stripe invoices.

Built for the [Galuxium Nexus V2](https://galuxium-nexus-v2-29411.devpost.com/) hackathon
(solo entry, fresh build).

## Architecture

```
Customer app ──x-api-key──▶ TokenTrace API (Express + Postgres)
                               ├─ key verify (sha256)
                               ├─ forward → upstream LLM (OpenAI-compatible)
                               └─ usage event → Postgres
Dashboard (Next.js) ──JWT──▶ same API (/api/*)
Stripe (test mode, Slice 4) ◀── nightly billing job
```

The dashboard never talks to the API from the browser: Next.js route handlers
proxy `/api/*` with the session JWT (first-party httpOnly cookie), so no CORS
is needed.

## Repo layout

- `server/` — Express API: proxy route, key management, migrations, tests
  - `server/src/` — app entry, routes, lib, db
  - `server/migrations/` — versioned SQL (`001_…` → `006_…`)
  - `server/test/` — vitest suite (runs on in-memory Postgres via pg-mem)
- `dashboard/` — Next.js 14 dashboard (App Router, Tailwind): login (JWT httpOnly
  cookie), Overview (usage stats + 30-day chart + top keys), API Keys
  (issue/show-once/revoke, quota config, admin-only writes), Audit Log
  (search + filters + expandable redacted rows), Billing (plan vs usage,
  overage estimate — Stripe wiring lands in Slice 4). Browser → Next.js
  `/api/*` proxy → Express; `API_URL` env (server-side only).

## Local setup (mock upstream — no API keys needed)

```bash
cd server
npm install
cp ../.env.example .env   # then set DATABASE_URL to a real Postgres
npm run seed              # creates the admin user (migrations run automatically on start)
MOCK_UPSTREAM=true npm start
```

Dashboard (needs the API running):

```bash
cd dashboard
npm install
cp .env.example .env.local  # API_URL=http://localhost:4000
npm run dev                 # http://localhost:3000 — log in with the seeded admin
```

With no Postgres handy, the test suite covers the whole Slice 1 surface on an
in-memory database:

```bash
cd server
npm install
npm test
```

Issue a key (via a quick node script or the dashboard in Slice 3), then proxy a call:

```bash
curl -s localhost:4000/v1/proxy/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: tt_live_...' \
  -d '{"model":"mock-model","messages":[{"role":"user","content":"Hello"}]}'
```

Set `UPSTREAM_BASE_URL` + `UPSTREAM_API_KEY` and unset `MOCK_UPSTREAM` to proxy a real
OpenAI-compatible endpoint. Token counts come from the upstream `usage` block when
present, otherwise estimated as `ceil(chars/4)` (disclosed approximation).

## Roadmap

- **Slice 1** ✅ — proxy core, key issuance/verification, usage metering, mock upstream, migrations
- **Slice 2** ✅ — PII redaction, audit-log writes, quotas + rate limits (429), audit search, retention purge
- **Slice 3** ✅ — Next.js dashboard (JWT auth + admin/viewer RBAC, overview charts, keys management, audit search, billing summary)
- **Slice 4** — Stripe test-mode metered billing + invoices
- **Slice 5** — hardening, professional docs, Render deploy
- **Slice 6** — Devpost submission + demo video

## License

MIT
