# TokenTrace — Deploy Runbook (Azure + Vercel)

Target: **Azure Container Apps** (API) + **Azure Database for PostgreSQL Flexible Server**
(B1ms Burstable) + **Vercel** (dashboard).

- Subscription: **Azure for Students** (account: james milton)
- Region: **West India (Mumbai)** — closest to the user
- Resource group: reuse **`imp_group`** (already West India)

> **Cost note (read this):** the Burstable **B1ms** Postgres SKU is the cheapest
> (~$15/month). That fits inside the Azure for Students **$100 credit** for the
> ~2-week demo/judging window (Oct 18 → Oct 31). **Delete or stop the Postgres
> server after judging ends** so it doesn't keep billing the credit.

Two paths below achieve the same result. **Path A (az CLI)** is recommended —
one command builds and deploys the API from source. **Path B (portal)** does
Postgres click-by-click and uses one CLI command for the code deploy (the
portal cannot build from source).

Do NOT run any of this from the dev VM beyond reading — provisioning happens
from your own machine after `az login`.

---

## 0. Prerequisites (both paths)

1. Install the Azure CLI: https://aka.ms/installazurecli
2. Log in (device-code flow — complete it in your browser when prompted):
   ```bash
   az login --use-device-code
   az account list -o table          # confirm "Azure for Students" is present
   az account set --subscription "Azure for Students"
   az extension add --name containerapp --upgrade
   ```
3. Generate the secrets you'll need (run anywhere):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # JWT_SECRET
   ```
   The rest come from the Doppler `muse`/`dev` vault (never paste them in chat):
   `PERFECTCORP_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`.
4. Decide the git branch to deploy: `slice-4-stripe-billing` (pre-merge) or `main`
   (after the slice branches are merged). The commands below use `$BRANCH`.

---

## Path A — az CLI (recommended)

```bash
# 1. Postgres Flexible Server — Burstable B1ms, PG 16, public access.
#    --public-access all opens 0.0.0.0/0. This is the pragmatic choice for a
#    2-week hackathon demo (Container Apps egress IPs are dynamic, so a tight
#    firewall rule isn't practical). Tighten or delete the server after judging.
az postgres flexible-server create \
  --resource-group imp_group \
  --name tokentrace-db \
  --location westindia \
  --sku-name Standard_B1ms \
  --tier Burstable \
  --storage-size 32 \
  --version 16 \
  --admin-user ttadmin \
  --admin-password '<STRONG_PASSWORD_8+_CHARS>' \
  --public-access all
# Takes ~5-10 minutes.

# 2. Database
az postgres flexible-server db create \
  --resource-group imp_group \
  --server-name tokentrace-db \
  --database-name tokentrace

# Connection string (save it — used below as DATABASE_URL):
# postgres://ttadmin:<pw>@tokentrace-db.postgres.database.azure.com:5432/tokentrace?sslmode=require

# 3. Container Apps environment
az containerapp env create \
  --name tokentrace-env \
  --resource-group imp_group \
  --location westindia

# 4. Build + deploy the API from source.
#    Uses server/Dockerfile (built server-side — no local Docker needed).
#    Migrations run automatically on boot; the app refuses to start in
#    production without JWT_SECRET.
cd /path/to/tokentrace
git checkout $BRANCH
az containerapp up \
  --name tokentrace-api \
  --resource-group imp_group \
  --location westindia \
  --environment tokentrace-env \
  --source ./server \
  --target-port 4000 \
  --ingress external \
  --env-vars \
    NODE_ENV=production \
    MOCK_UPSTREAM=false \
    DATABASE_URL='postgres://ttadmin:<pw>@tokentrace-db.postgres.database.azure.com:5432/tokentrace?sslmode=require' \
    JWT_SECRET='<64-hex-chars-from-step-0>' \
    UPSTREAM_BASE_URL='https://yce-api-01.makeupar.com' \
    UPSTREAM_API_KEY='<Doppler: PERFECTCORP_API_KEY>' \
    STRIPE_SECRET_KEY='<Doppler: STRIPE_SECRET_KEY>' \
    STRIPE_PUBLISHABLE_KEY='<Doppler: STRIPE_PUBLISHABLE_KEY>' \
    CORS_ORIGIN=''

# 5. Get the public URL
az containerapp show --name tokentrace-api --resource-group imp_group \
  --query properties.configuration.ingress.fqdn -o tsv
# → https://tokentrace-api.<hash>.westindia.azurecontainerapps.io
curl https://<that-fqdn>/health        # expect {"ok":true,"service":"tokentrace-api"}

# 6. Stripe plans + admin seed — these MUST run on Azure, not the dev VM
#    (Stripe's API is unreachable from the dev VM; it works fine on Azure).
az containerapp exec --name tokentrace-api --resource-group imp_group \
  --command "npm run plans:sync"      # idempotent: creates Starter/Pro products+prices

az containerapp update --name tokentrace-api --resource-group imp_group \
  --set-env-vars ADMIN_EMAIL='<you@example.com>' ADMIN_PASSWORD='<strong-password>'
az containerapp exec --name tokentrace-api --resource-group imp_group \
  --command "npm run seed"            # idempotent: skips if the admin exists

# 7. Stripe webhook — Stripe dashboard → Developers → Webhooks → Add endpoint:
#      URL:    https://<fqdn>/api/webhooks/stripe
#      Events: invoice.paid, invoice.payment_failed
#    Reveal the signing secret and set it:
az containerapp update --name tokentrace-api --resource-group imp_group \
  --set-env-vars STRIPE_WEBHOOK_SECRET='<whsec_...>'

# 8. Dashboard on Vercel
#    dashboard.vercel.com → Add New → import pintu544/tokentrace →
#    Root Directory: dashboard → Framework: Next.js →
#    env: NEXT_PUBLIC_API_URL=https://<containerapp-fqdn> → Deploy.
#    (Or with the CLI: cd dashboard && vc --prod, then set the env var in the
#    Vercel dashboard and redeploy.)
#    Then point the API at it:
az containerapp update --name tokentrace-api --resource-group imp_group \
  --set-env-vars CORS_ORIGIN='https://<vercel-dashboard-url>'

# 9. Verify end-to-end
#    - Open https://<vercel-url>/login, sign in with the seeded admin.
#    - Keys → issue a key (copy it — shown once).
#    - From your machine:
curl -X POST https://<fqdn>/v1/proxy/chat/completions \
  -H 'x-api-key: tt_live_...' -H 'Content-Type: application/json' \
  -d '{"model":"demo","messages":[{"role":"user","content":"ping"}]}'
#    (MOCK_UPSTREAM=false + a real upstream key → real forwarding. With the
#    Perfect Corp grant: POST https://<fqdn>/v1/proxy/upstream/s2s/v2.0/... )
#    - Dashboard → Overview shows the tokens; Audit shows the redacted call.
```

**Scale-to-zero note:** the consumption profile scales to zero when idle; the
first request after idle takes ~10–30s (cold start). Add this keepalive
workflow to keep `/health` warm during the demo/judging window, then disable it
afterwards.

> **Add it via the GitHub web UI** (repo → Actions → *New workflow* → paste):
> the automation token cannot push `.github/workflows/*` files (missing
> `workflow` scope), so this file is intentionally not in the repo yet.

```yaml
# .github/workflows/keepalive.yml
# Set API_URL as a repo variable (Settings → Secrets and variables → Actions →
# Variables), e.g. https://tokentrace-api.<hash>.westindia.azurecontainerapps.io
name: keepalive
on:
  schedule:
    - cron: '*/10 * * * *'
  workflow_dispatch:
jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - name: Ping /health
        run: |
          code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "${API_URL}/health")
          echo "health -> HTTP $code"
          [ "$code" = "200" ]
        env:
          API_URL: ${{ vars.API_URL }}
```

---

## Path B — Azure portal (+ one CLI command for code)

**B1. Postgres (fully clickable)**

1. https://portal.azure.com → search **"Azure Database for PostgreSQL flexible servers"** → **Create**.
2. Basics: Subscription = *Azure for Students*; Resource group = *imp_group*;
   Server name = `tokentrace-db`; Region = *West India*; PostgreSQL version =
   **16**; Workload type = *Development*; click **Configure server** →
   Compute tier = **Burstable**, Size = **Standard_B1ms** → Save.
   Authentication: *PostgreSQL authentication only*; admin username `ttadmin`
   + a strong password (save it — you need it for DATABASE_URL).
3. **Networking** tab → Connectivity method: *Public access (allowed IP
   addresses)* → check **"Allow public access from any Azure service within
   Azure to this server"** → **+ Add current client IP address** (handy for
   debugging) → also add a rule `0.0.0.0`–`255.255.255.255` named
   `allow-all-demo`. (Same tradeoff as Path A: pragmatic for 2 weeks, delete
   the server after judging.)
4. **Review + create** → wait for deployment (~5–10 min).
5. Open the server → **Databases** → **+ Add** → name `tokentrace` → Save.
   Connection string:
   `postgres://ttadmin:<pw>@tokentrace-db.postgres.database.azure.com:5432/tokentrace?sslmode=require`

**B2. Container App shell (portal) + code deploy (one CLI command)**

The portal cannot build from source, so:

1. Portal → search **"Container Apps"** → **Create**.
2. Basics: Subscription = *Azure for Students*; Resource group = *imp_group*;
   Container app name = `tokentrace-api`; Region = *West India*;
   Container Apps Environment → **Create new** → name `tokentrace-env` → Create.
3. **Container** tab: keep *Use quickstart image* checked for now (it gets
   replaced in step 6). **Ingress**: enable, *External*, target port **4000**.
4. **Review + create**.
5. Open the app → **Configuration** → add every env var from the checklist in
   §Env var checklist below (DATABASE_URL, JWT_SECRET, …, CORS_ORIGIN empty
   for now). Save (this restarts the app).
6. Deploy the code (the single CLI step — needs `az login` done once):
   ```bash
   cd /path/to/tokentrace && git checkout $BRANCH
   az containerapp up --name tokentrace-api --resource-group imp_group \
     --source ./server
   ```
7. Continue from **Path A steps 5–9** (FQDN, plans:sync, seed, webhook,
   Vercel, verify).

---

## Env var checklist (API)

| Variable | Value / source | Required |
|---|---|---|
| `NODE_ENV` | `production` | yes |
| `PORT` | `4000` (default) | no |
| `DATABASE_URL` | Azure Postgres connection string above (`?sslmode=require`) | yes |
| `JWT_SECRET` | 64 hex chars (generate, step 0) — app refuses to boot in prod without it | yes |
| `UPSTREAM_BASE_URL` | `https://yce-api-01.makeupar.com` (Perfect Corp) | yes for real upstream |
| `UPSTREAM_API_KEY` | Doppler `PERFECTCORP_API_KEY` | yes for real upstream |
| `MOCK_UPSTREAM` | `false` in production (`true` = canned responses, no keys needed) | yes |
| `STRIPE_SECRET_KEY` | Doppler `STRIPE_SECRET_KEY` (test mode) | for billing |
| `STRIPE_PUBLISHABLE_KEY` | Doppler `STRIPE_PUBLISHABLE_KEY` | for billing page |
| `STRIPE_WEBHOOK_SECRET` | Stripe dashboard after registering the webhook (step 7) | for webhooks |
| `CORS_ORIGIN` | `https://<vercel-dashboard-url>` (empty = default deny) | recommended |
| `REST_BODY_LIMIT_MB` | `10` (default) | no |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | only needed for `npm run seed` | seed only |

Dashboard (Vercel): `NEXT_PUBLIC_API_URL=https://<containerapp-fqdn>`

## After judging

1. Disable the keepalive workflow (or delete `.github/workflows/keepalive.yml`).
2. **Delete the Postgres server** (`az postgres flexible-server delete
   --resource-group imp_group --name tokentrace-db --yes`) — or at least stop
   it — so the B1ms meter stops against the student credit.
3. Optionally scale the Container App to zero / delete it (consumption plan
   costs ~nothing idle, but tidy is tidy).

## Troubleshooting

- **App won't start / CrashLoop**: `az containerapp logs show --name tokentrace-api
  --resource-group imp_group --follow`. First suspects: `JWT_SECRET` unset
  (fatal in production by design) or a bad `DATABASE_URL`.
- **DB connection refused**: check the firewall rules on the Postgres server
  (the `allow-all-demo` rule) and `?sslmode=require` on the connection string.
- **Stripe calls fail from the app**: `STRIPE_SECRET_KEY` must be the test key
  (`sk_test_…`); the dev VM can't reach Stripe at all, so always verify from
  Azure (`az containerapp exec`).
- **Dashboard shows network errors**: `NEXT_PUBLIC_API_URL` must be the
  Container App FQDN (https), and `CORS_ORIGIN` on the API must match the
  Vercel URL exactly (no trailing slash).
