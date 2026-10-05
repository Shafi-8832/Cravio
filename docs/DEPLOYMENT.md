# Deploying Cravio (Vercel + Render + Neon)

```
Browser ──HTTPS──▶ Vercel (React build, static files)
   │
   └──HTTPS /api/*──▶ Render (Express, backend/) ──TLS──▶ Neon PostgreSQL
```

Only the Render backend holds `DATABASE_URL`. The browser never talks to
PostgreSQL; the frontend bundle contains nothing but the public API address.

---

## A. Local preparation

1. `npm run test:backend` with `TEST_DATABASE_URL` pointing at a disposable
   `*_test` database — all suites must pass.
2. `cd frontend && npm run lint && npm run build` — must succeed.
3. `git status` — confirm no `.env` file is listed (both are gitignored).

## B. GitHub

Render and Vercel deploy from the GitHub repository, so every change must be
committed and pushed to the branch you deploy (normally `main`). The account
you sign in to Render/Vercel with needs access to the repository.

## C. Render — backend (Web Service)

**Fastest way:** Render → **New → Blueprint** → pick this repository. The
`render.yaml` file at the repo root fills in every field below, generates
`JWT_SECRET` and `OTP_HMAC_SECRET`, and asks only for the secrets
(`DATABASE_URL`, `CORS_ORIGIN`, `BREVO_API_KEY`, `EMAIL_FROM`,
`BULKSMSBD_API_KEY`, `BULKSMSBD_SENDER_ID`). The manual settings, for a
service created by hand:

| Field | Value |
|---|---|
| Source | the Cravio GitHub repository, branch `main` |
| Language / Runtime | Node |
| Root Directory | `backend` |
| Build Command | `npm install` |
| Start Command | `npm start` (runs `node server.js`) |
| Health Check Path | `/api/health` |
| Instance type | Free works; it sleeps after ~15 idle minutes and takes up to ~1 minute to wake (the frontend waits 60 s) |

Do **not** add `npm run db:migrate` or any `seed` script to the build or
start command. Database changes are run by hand (section D).

Node version comes from `"engines": { "node": ">=20" }` in
`backend/package.json`.

## D. Neon — database

- The production database already exists. Never run `backend/db/schema.sql`
  against it: it begins with `DROP TABLE` statements.
- Use Neon's **pooled** connection string (host contains `-pooler`).
  Replace `sslmode=require` with `sslmode=verify-full` to keep full TLS
  verification and silence a `pg` warning.
- When a new migration is added later, apply it from a developer machine:
  set `DATABASE_URL` in `backend/.env` to the Neon URL and run
  `npm run db:migrate` from the repo root. The runner is additive: it only
  bootstraps an empty database, skips applied migrations, and refuses to run
  if an applied migration file was edited.
- Never set `ALLOW_DEMO_SEED=true` against Neon.

## E. Vercel — frontend

| Field | Value |
|---|---|
| Framework Preset | Vite |
| Root Directory | `frontend` |
| Install Command | `npm install` |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Environment variable | `VITE_API_URL` = `https://<your-service>.onrender.com` (https, no trailing slash) |

- `frontend/vercel.json` rewrites every path to `index.html`, so refreshing
  `/restaurants/12`, `/owner/analytics`, `/verify` etc. works.
- The build **fails on purpose** on Vercel if `VITE_API_URL` is missing or not
  `https://` (check in `frontend/vite.config.js`).
- `VITE_API_URL` is baked in at build time: after changing it, redeploy.

## F. Environment variables (Render → Environment)

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Neon pooled URL (`...-pooler...?sslmode=verify-full&channel_binding=require`) |
| `JWT_SECRET` | new random value: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `OTP_HMAC_SECRET` | another new random value (same command) |
| `CORS_ORIGIN` | `https://<your-project>.vercel.app` — exact, no trailing slash; comma-separate to add a custom domain |
| `EMAIL_PROVIDER` | `brevo` |
| `BREVO_API_KEY` | Brevo → SMTP & API → API keys |
| `EMAIL_FROM` | `Cravio <address-verified-in-brevo>` |
| `SMS_PROVIDER` | `bulksmsbd` |
| `BULKSMSBD_API_KEY` | BulkSMSBD dashboard |
| `BULKSMSBD_SENDER_ID` | your approved sender ID |
| `ALLOW_MANUAL_PAYMENTS` | `false` unless you reconcile wallet payments by hand |

Do not set: `PORT` (Render provides it), `TEST_DATABASE_URL`, `AUTH_RATE_LIMIT`,
`ADMIN_*`, `DEMO_PASSWORD`, `ALLOW_DEMO_SEED`, `BRAND_OWNER_PASSWORD`.
Optional: `OSRM_BASE_URL`, `ENABLE_GOOGLE_PLACES`, `GOOGLE_PLACES_API_KEY`.

The server checks the OTP settings at startup and **refuses to start** (with
the reason in the Render log) if a provider key is missing, if
`OTP_HMAC_SECRET` is too short, or if the development `outbox` provider is
selected on Render.

## G. CORS

`backend/server.js` allows only the origins listed in `CORS_ORIGIN`. Vercel
*preview* deployments have different URLs and are blocked unless you add
them. Requests without an `Origin` header (curl, Postman) are allowed; that
is safe because authentication is a Bearer token, not a cookie.

## H. Production testing

1. `https://<render>/api/health` → `{"status":"ok","database":"connected",...}`.
2. Open the Vercel URL; the home page and restaurant list load (images come
   from `<render>/media/...`).
3. Sign up → both codes arrive → verify → log in.
4. Log in as each role (customer, restaurant owner, rider, admin) and open
   that role's dashboard directly by URL; open another role's page → refused.
5. Customer: add to cart, reload (cart persists), checkout, see the order
   in My Orders; owner accepts/prepares; rider picks up/delivers; admin sees it.
6. Log out, then reuse the old token (e.g. Postman) → 401.
7. Refresh every route above → no Vercel 404.
8. Browser console: no CORS or mixed-content errors. Render log: no errors.

## I. Common errors and fixes

| Symptom | Cause | Fix |
|---|---|---|
| Render deploy fails, log says "OTP delivery is misconfigured" | provider key or secret missing | add the variable named in the log |
| Browser: "blocked by CORS policy" | `CORS_ORIGIN` ≠ the exact Vercel URL | copy the URL from the address bar, no trailing slash, redeploy Render |
| "Cannot reach the server" on first load | free instance waking up | wait and retry; or upgrade the instance |
| Vercel build error "VITE_API_URL must be set" | variable missing | add it in Vercel settings, redeploy |
| 404 on refresh at Vercel | `vercel.json` not in `frontend/` | Root Directory must be `frontend` |
| Every login returns 429 | proxy IP shared by all users | `NODE_ENV=production` must be set (enables `trust proxy`) |
| `PostgreSQL connection error` in Render log | wrong/expired `DATABASE_URL` | re-copy the pooled URL from Neon |
| Signup works but no email | Brevo sender not verified, or key wrong | check the "OTP email delivery failed" line in the Render log |
| Login says "verify your email and phone" for an old account | migration 013 not applied | run `npm run db:migrate` against Neon (section D) |
