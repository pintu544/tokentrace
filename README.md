# TokenTrace — meter, audit, and bill every AI API call

A drop-in proxy + dashboard for AI API usage. Route your AI API calls through
TokenTrace with a per-customer API key (`tt_live_…`); it forwards to your
upstream provider while **metering usage per key**, keeping a **PII-redacted
audit trail**, enforcing **quotas and rate limits** (HTTP 429), and turning
usage into **Stripe invoices**.

Built for the [Galuxium Nexus V2](https://galuxium-nexus-v2-29411.devpost.com/)
hackathon (solo entry, fresh build).

## Features

- **Two proxy modes** — OpenAI-compatible chat (`POST /v1/proxy/chat/completions`)
  and a generic REST passthrough (`ANY /v1/proxy/upstream/*`) for non-chat AI
  APIs (verified live against Perfect Corp's YouCam virtual try-on API).
- **Per-customer API keys** — `tt_live_` keys, sha256-hashed at rest, show-once
  issuance, revocation, per-key monthly quotas and per-minute rate limits.
- **PII-redacted audit log** — every successful call stored with emails, phone
  numbers and secrets scrubbed; binary bodies stored as metadata only.
- **Dashboard** (Next.js) — JWT login with admin/viewer RBAC, usage overview,
  key management, audit search, billing with real invoice history.
- **Stripe billing (test mode)** — Starter $19/mo (1M tokens), Pro $79/mo (10M),
  $0.002/1K overage; idempotent nightly billing job; webhooks update invoice
  status.
- **Hardened API** — security headers, CORS default-deny allowlist, body size
  limits, timing-safe key comparison, no stack-trace leaks, login throttling.

## Architecture

```
Customer app ──x-api-key──▶ TokenTrace API (Express + Postgres, Azure)
                               ├─ key verify (sha256, timing-safe)
                               ├─ quota + rate-limit checks (429 before spend)
                               ├─ forward → upstream (Bearer injected server-side)
                               ├─ usage event → Postgres
                               └─ redacted audit row → Postgres (same txn)
Dashboard (Next.js, Vercel) ──JWT──▶ same API (/api/*, via route handlers)
Stripe (test mode) ◀── nightly billing job + webhooks
```

The browser never calls the API directly: Next.js route handlers proxy `/api/*`
with the session JWT from an httpOnly cookie, so no CORS is needed in the
reference deployment.

## Quickstart (mock mode — 5 minutes, no keys needed)

```bash
cd server
npm install
npm test                    # full suite on in-memory Postgres (no DB needed)
cp .env.example .env        # MOCK_UPSTREAM=true by default
npm run seed                # creates the admin user (idempotent)
MOCK_UPSTREAM=true npm start
```

Dashboard (needs the API running):

```bash
cd dashboard
npm install
cp .env.example .env.local  # API_URL=http://localhost:4000
npm run dev                 # http://localhost:3000 — log in with the seeded admin
```

Issue a key (dashboard → Keys, or `POST /api/keys` as admin), then proxy a call:

```bash
curl -s localhost:4000/v1/proxy/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: tt_live_...' \
  -d '{"model":"mock-model","messages":[{"role":"user","content":"Hello"}]}'
```

Set `UPSTREAM_BASE_URL` + `UPSTREAM_API_KEY` and `MOCK_UPSTREAM=false` to proxy
a real endpoint. Token counts come from the upstream `usage` block when present,
otherwise estimated as `ceil(chars/4)` (disclosed approximation).

## REST passthrough (non-chat AI APIs)

Not every AI API speaks chat completions. `ANY /v1/proxy/upstream/*` forwards the
method, path, query string and body to `${UPSTREAM_BASE_URL}`, injecting your
server-side upstream key as `Authorization: Bearer` (your customer's `x-api-key`
is TokenTrace's key and is never forwarded). Same enforcement as the chat path:
key verify → rate limit → quota → forward → meter + audit in one transaction.

Metering: REST upstreams expose no token usage, so "tokens" are size-estimated
(`ceil(bytes/4)`, request bytes = prompt, response bytes = completion) — not
model-counted. Binary bodies are never stored in the audit log; only
`{content_type, byte_size, sha256_prefix}` metadata is kept. Failed upstream
calls (non-2xx) pass through verbatim and are never metered or billed.

YouCam virtual try-on flow through the proxy (grant API, task-based).
Verified live 2026-10-18: file API ×2 → S3 PUTs → task create, all through
the proxy with Bearer injection (the task itself needs grant units on the key):

```bash
TT=https://<your-api-fqdn>   # e.g. tokentrace-api.<hash>.westindia.azurecontainerapps.io
KEY=tt_live_...              # a TokenTrace key you issued

# 1. Ask the File API for an upload slot (proxied; Bearer injected server-side)
curl -s $TT/v1/proxy/upstream/s2s/v2.0/file/hat \
  -H "x-api-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"files":[{"content_type":"image/jpg","file_name":"selfie.jpg","file_size":37005}]}'
# → {status:200, data:{files:[{file_id:"...", requests:[{method:"PUT", url:"<s3-presigned>"}]}]}}

# 2. PUT the bytes to the presigned S3 URL (direct — not proxied, no AI units)
curl -s -X PUT '<s3-presigned-url>' -H 'Content-Type: image/jpg' --data-binary @selfie.jpg

# 3. Create ONE try-on task (proxied; consumes 1 grant unit on success)
curl -s $TT/v1/proxy/upstream/s2s/v2.0/task/hat \
  -H "x-api-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"src_file_id":"<selfie-file-id>","ref_file_id":"<hat-file-id>","gender":"female","style":"random"}'
# → {status:200, data:{task_id:"..."}}

# 4. Poll until success — every call is metered against the customer's key
curl -s "$TT/v1/proxy/upstream/s2s/v2.0/task/hat/<task_id>" -H "x-api-key: $KEY"
# → {status:200, data:{task_status:"success", results:{url:"<result-image>"}}}
```

## API reference

### Proxy (customer-facing, `x-api-key` header)

| Method & path | Description |
|---|---|
| `POST /v1/proxy/chat/completions` | OpenAI-compatible chat passthrough; returns upstream response verbatim |
| `ANY /v1/proxy/upstream/*` | Generic REST passthrough; method/path/query/body preserved |

Errors: `401` bad/revoked key · `429` quota or rate-limit exceeded (with
`retry_after_seconds`) · `413` body too large · `502/504` upstream failure/timeout.

### Dashboard API (JWT session, `/api/*` via Next.js)

| Method & path | Role | Description |
|---|---|---|
| `POST /api/auth/login` | public | Email+password → httpOnly session cookie |
| `GET /api/auth/me` | any | Current user |
| `GET /api/keys` | viewer+ | List keys |
| `POST /api/keys` | admin | Issue key (plaintext shown once) |
| `PATCH /api/keys/:id` | admin | Quota/rate config |
| `POST /api/keys/:id/revoke` | admin | Revoke |
| `GET /api/audit` | viewer+ | Search audit (`key_id`, `from`/`to`, `model`, `q`, pagination) |
| `GET /api/stats/overview` | viewer+ | Tokens/requests today + month, top keys |
| `GET /api/stats/daily?days=` | viewer+ | Per-day buckets |
| `GET /api/billing/summary` | viewer+ | Plan vs usage, overage estimate |
| `GET /api/billing/invoices` | viewer+ | Invoice history |
| `POST /api/billing/customer` | admin | Create Stripe customer link |
| `POST /api/webhooks/stripe` | public | Stripe webhook (signature-verified) |

## Environment variables

API (`server/.env` — see `server/.env.example` for the annotated template):

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string (`?sslmode=require` on Azure) |
| `JWT_SECRET` | yes (prod) | 64 hex chars; app refuses to boot in prod without it |
| `UPSTREAM_BASE_URL` | for real mode | e.g. `https://yce-api-01.makeupar.com` |
| `UPSTREAM_API_KEY` | for real mode | Server-side only, injected as Bearer |
| `MOCK_UPSTREAM` | — | `true` = canned responses (default in example) |
| `STRIPE_SECRET_KEY` | for billing | Test mode (`sk_test_…`) for the hackathon |
| `STRIPE_PUBLISHABLE_KEY` | for billing | Test mode |
| `STRIPE_WEBHOOK_SECRET` | for webhooks | From Stripe dashboard / `stripe listen` |
| `CORS_ORIGIN` | recommended | Comma-separated allowlist; empty = default deny |
| `REST_BODY_LIMIT_MB` | no | Non-JSON body cap, default `10` |
| `NODE_ENV` | — | `production` on Azure |

Dashboard (`dashboard/.env.local`): `NEXT_PUBLIC_API_URL` (API base URL).

## Project structure

```
server/
  src/
    app.js            Express factory (security headers, CORS, routers)
    index.js          Entry: migrate() then listen (refuses prod boot w/o JWT_SECRET)
    db.js             pg pool + versioned migration runner
    seed.js           Idempotent admin seed (safe to re-run)
    lib/              keys (timing-safe verify), auth (JWT/scrypt), limits,
                      redact (PII), tokens (usage), upstream, restUpstream, stripe
    middleware/       auth (JWT+RBAC), security (headers, CORS)
    routes/           proxy, keys, audit, stats, billing, auth, webhooks
    jobs/             billing (nightly invoices), retention (purge), sync-plans
  migrations/         001–007 versioned SQL
  test/               vitest suite (pg-mem, no network/DB needed)
  Dockerfile          Production image (Azure Container Apps)
dashboard/            Next.js 14 App Router + Tailwind (login, overview, keys,
                      audit, billing; API proxied server-side via route handlers)
docs/DEPLOY.md        Azure + Vercel deploy runbook (az CLI + portal paths)
.github/workflows/keepalive.yml   Optional /health pinger for the demo window
```

## Deploy

Full runbook: [docs/DEPLOY.md](docs/DEPLOY.md) — Azure Container Apps (API) +
Azure Database for PostgreSQL Flexible Server (B1ms, ~$15/mo, fits the student
credit) + Vercel (dashboard). Migrations run on boot; `npm run plans:sync` and
`npm run seed` run once via `az containerapp exec`.

## Honest limitations

- **Mock vs production**: `MOCK_UPSTREAM=true` returns canned responses — the
  demo works fully without spending anything, but it proves the plumbing, not
  the upstream.
- **Redaction is regex-based** (emails, phones, key-like secrets) — best effort,
  not a compliance guarantee.
- **REST "tokens" are size-estimated** (`ceil(bytes/4)`), not model-counted —
  disclosed in code and docs.
- **Tests run on pg-mem**, not real Postgres — migrations 005–007 meet real
  Postgres for the first time at deploy.
- **Login throttling is in-memory** (per instance, resets on restart) — fine for
  the demo scale, not for multi-instance production.
- **Stripe is test mode** — no real money moves.

## Roadmap

- **Slice 1** ✅ — proxy core, key issuance/verification, usage metering, mock upstream, migrations
- **Slice 2** ✅ — PII redaction, audit-log writes, quotas + rate limits (429), audit search, retention purge
- **Slice 3** ✅ — Next.js dashboard (JWT auth + admin/viewer RBAC, overview charts, keys management, audit search, billing summary)
- **Slice 3b** ✅ — generic REST passthrough (metered, audited, quota/rate-limited; verified live vs YouCam API)
- **Slice 4** ✅ — Stripe test-mode metered billing: plans, idempotent nightly billing job, invoice items + finalized invoices, webhooks, plans sync
- **Slice 5** ✅ — security hardening, professional docs, Azure deploy runbook
- **Slice 6** — Devpost submission + demo video (deadline Oct 31, 5:00 PM IST)

## License

MIT
