# AgentPlan

Publish agent-generated static HTML documents behind stable, shareable links.

AgentPlan is a small service for AI agents (and their humans) that need to turn a
generated HTML file — a plan, a report, a dashboard — into a URL. Upload from the
browser, the API, or the CLI:

```bash
npx agentplan upload ./plan.html
```

Every upload gets a stable link like `https://agentplan.app/p/launch-plan-x7k2`,
immutable version history, and owner-controlled visibility — `private` (owner
only, the default), `public` (anyone with the link), or `password` (anyone with
the link and the password).

## How it works

- **Next.js (App Router)** application deployed on Vercel with the Node.js runtime.
- **PlanetScale Postgres** with Drizzle ORM for drafts, versions, tokens, and audit events.
- **Private Cloudflare R2 bucket** (S3-compatible API) for all uploaded HTML —
  visibility is enforced by the application, never by the storage layer.
- **Better Auth** with verified email/password and optional GitHub OAuth (offered
  only when `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` are set) for browser sessions;
  scoped API tokens (`ap_live_…`, stored as SHA-256 hashes) for agents and the CLI.
  On an empty database, only `ADMIN_BOOTSTRAP_EMAIL` can register; that identity
  becomes the single initial admin. Admins can disable sign-ups, change account
  plans and roles, delete accounts, and moderate individual uploads under
  `/dashboard/admin`.
- Uploaded HTML is treated as hostile. It is never rendered into the application DOM;
  it is served from an isolated route and displayed inside a sandboxed iframe
  (`sandbox="allow-scripts allow-forms allow-modals allow-popups"`, no
  `allow-same-origin`).

## Architecture

```text
Browser ─┐                              ┌── PlanetScale Postgres (Drizzle)
         ├─ Next.js App Router (Vercel) ─┤
CLI / ───┘   • pages + server actions    └── Cloudflare R2 (private, S3 API)
Agents         • /api/v1 (token auth)
               • /p/{slug} sandboxed viewer
```

Request paths:

- **Browser** → same-origin API routes and small server actions → draft/token services
  → Postgres + R2. Upload rate reservations happen before multipart parsing.
  Authorization uses sessions and owner-scoped queries.
- **Agent / CLI** → `POST /api/v1/drafts` with `Authorization: Bearer ap_live_…` →
  scope-checked → same services.
- **Viewer** → `/p/{slug}` renders an iframe whose `src` is `/p/{slug}/content`; the
  content route re-authorizes server-side and streams the HTML from R2.

Key directories:

```text
app/            Routes: landing, dashboard, /p/[slug] viewer, /api/v1, /api/auth
components/     UI (auth buttons, dashboard widgets)
db/             Drizzle schema, pooled client, owner-scoped queries
drizzle/        Generated, committed SQL migrations
lib/
  auth/         Better Auth instance + session helpers (requireUser, getOptionalUser)
  drafts/       Upload/version/restore service + slug generation
  storage/      ObjectStorage interface: R2 (prod) and fs (dev/CI)
  tokens/        Token generation, hashing, bearer authentication
  api/           Request auth, response envelopes, serializers
  validation/    Zod schemas + upload validation
packages/cli/    The `agentplan` CLI (npm workspace)
tests/           unit / security / integration (Vitest) + e2e (Playwright)
```

## Local setup

Requirements: Node.js 24+, npm, and a Postgres instance (a PlanetScale branch or
local Postgres).

1. `npm ci`
2. Copy `.env.example` to `.env` and fill in values (PlanetScale URLs,
   `ADMIN_BOOTSTRAP_EMAIL`, Better Auth secret, R2 credentials, and optional GitHub
   OAuth). Email/password development also needs an email webhook; without one,
   development suppresses delivery and an unverified account cannot sign in.
3. `npm run db:migrate` (uses `DATABASE_URL_DIRECT`)
4. `npm run dev`

For local development without R2 credentials, set `STORAGE_DRIVER=fs` to store
uploaded HTML on the local filesystem instead. This driver is disabled in
production builds.

### Quality gates

```bash
npm run check     # lint + typecheck + unit/security/integration tests + build
npm run test:e2e  # Playwright hostile-HTML browser tests (needs DATABASE_URL)
```

The test suite runs against a real Postgres database. Point `TEST_DATABASE_URL`
(unit/integration) or `DATABASE_URL` (e2e) at a disposable branch or local instance;
tests that require a database skip automatically when it is absent.

## CLI

Install-free usage via `npx agentplan`, or `npm link` inside `packages/cli` for
local development.

```bash
agentplan login                          # store an API token (created in the dashboard)
agentplan logout
agentplan upload ./plan.html             # new draft, private by default
agentplan upload ./plan.html --public
agentplan upload ./plan.html --password hunter2   # password-protected (visible in process args)
agentplan upload ./plan.html --password-stdin     # safer: read password from piped/redirected stdin
agentplan upload ./plan.html --title "Launch plan"
agentplan upload ./plan.html --draft <id>   # add a new version to an existing draft
agentplan upload ./plan.html --json      # machine-readable output on stdout
agentplan list [--json]
agentplan open <id>
```

Authentication precedence: `AGENTPLAN_TOKEN` → stored login → interactive prompt.
Tokens are stored in the OS configuration directory (`~/.config/agentplan` on Linux/macOS)
with owner-only permissions. `--json` writes only JSON to stdout; diagnostics go to
stderr; missing or revoked tokens exit non-zero. Custom API endpoints must use HTTPS;
cleartext HTTP is accepted only for localhost. Authenticated requests never follow
redirects, and interactive token entry is hidden.

## API

All routes are under `/api/v1` and authenticate with `Authorization: Bearer ap_live_…`
(agents) or a browser session cookie.

```text
POST   /api/v1/drafts                              (multipart file upload)
GET    /api/v1/drafts
GET    /api/v1/drafts/:id
PATCH  /api/v1/drafts/:id                           { title?, visibility? }
DELETE /api/v1/drafts/:id
POST   /api/v1/drafts/:id/versions                  (multipart file upload)
GET    /api/v1/drafts/:id/versions
POST   /api/v1/drafts/:id/versions/:versionId/restore
GET    /api/v1/tokens                               (session only)
POST   /api/v1/tokens                               (session only)
DELETE /api/v1/tokens/:id                           (session only)
```

Errors have a stable shape agents can match on:

```json
{ "error": { "code": "INVALID_FILE_TYPE", "message": "Only HTML files are supported." } }
```

## Limits & abuse protection

Free-plan limits (all server-enforced; tunable via `AP_*` env vars, defaults in
`lib/limits/plans.ts`):

| Limit | Default |
| --- | --- |
| Upload size | 2 MiB per HTML file |
| Drafts per user | 100 |
| Versions kept per draft | 100 (oldest are pruned, uploads never hard-fail) |
| Total storage per user | 250 MiB |
| Active API tokens per user | 25 |
| Uploads per user | 30 / 10 min and 300 / day |
| Token create/revoke operations | 60 / hour and 200 / day |
| Draft password attempts | 10 / 15 min per draft + IP |

Exceeded quotas return `403 QUOTA_EXCEEDED`; rate limits return `429 RATE_LIMITED`
with a `Retry-After` header. Rate limiting is a fixed-window counter in Postgres, so
it needs no extra infrastructure and is correct across serverless instances.

Soft-deleted drafts (and their stored objects) are hard-deleted after 7 days by a
daily cron (`/api/cron/purge`, authorized via `CRON_SECRET`).
Revoked/expired token rows are removed after 30 days, and ordinary audit events
after 180 days. Pending user-deletion cleanup jobs are retained until object cleanup
completes; their object keys and target identifier are erased at completion.

Admins can switch a user between `free` and `unlimited` from the user list.
The CLI remains available for operators (needs `DATABASE_URL`, loaded from
`.env` automatically):

```bash
bun scripts/set-user-plan.ts someone@example.com unlimited   # back to normal: … free
```

The admin content view searches live uploads by title, slug, or owner email.
Removing an upload makes every viewer and API route return not found immediately;
its private objects follow the same 7-day hard-deletion window as an owner-initiated
draft deletion.

## Security

AgentPlan hosts arbitrary, hostile HTML. See [SECURITY.md](SECURITY.md) for the full
threat model. In short:

- Uploaded HTML is served only from an isolated route inside a sandboxed iframe, in an
  opaque origin. Uploaded scripts run, but cannot read AgentPlan cookies, touch the
  parent DOM, navigate the parent, or make credentialed requests to AgentPlan.
- All HTML lives in a private R2 bucket; visibility is an application-level decision
  enforced on every request. Private drafts return `404` to non-owners.
- Password-protected drafts store a salted scrypt hash of the password. Entering
  the correct password issues an HMAC-signed, draft-scoped, HttpOnly access cookie
  (12h); the content route serves the HTML only with a valid cookie (or to the
  owner) and never caches it publicly. The owner always bypasses the prompt.
- API tokens are stored only as SHA-256 hashes and compared in constant time.
- Protected drafts use random title-independent slugs. Moving a public draft back
  to private/password rotates its slug.
- Application pages use a per-request nonce CSP; API responses are private/no-store.
- Only `.env.example` placeholders are committed; CI scans the working tree and
  complete reachable history for recognized credential formats.

## Deployment (Vercel)

Production deployment is a deliberate, credentialed step. Runbook:

1. Import the public GitHub repo into Vercel; enable Fluid Compute.
2. Create a **private** Cloudflare R2 bucket and an S3 API token scoped to it.
3. In PlanetScale, create a **restricted application role** (not the admin role) and
   use its PgBouncer (pooled) URL for `DATABASE_URL`; keep the direct URL for
   migrations only.
4. Configure production env vars in Vercel: `DATABASE_URL`, `DATABASE_URL_DIRECT`,
   `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `ADMIN_BOOTSTRAP_EMAIL`,
   `AUTH_EMAIL_WEBHOOK_URL`, `AUTH_EMAIL_WEBHOOK_SECRET`, `AUTH_EMAIL_FROM`,
   `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` (optional),
   `NEXT_PUBLIC_APP_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_BUCKET`, `CRON_SECRET` (authorizes the daily purge cron).
   The email webhook receives bearer-authenticated `POST` JSON with
   `{ kind, to, name, url, from }`, must deliver the link without logging it, and
   return a 2xx response.
5. Run migrations against production using the direct URL: `npm run db:migrate`.
   Migration `0005_security_hardening.sql` rotates every existing non-public draft
   slug, intentionally invalidating previously shared private/password URLs.
6. Deploy, verify auth on the Vercel domain, then attach `agentplan.app` and redirect
   `www` → apex.
7. In every deployment, update `BETTER_AUTH_URL` / `NEXT_PUBLIC_APP_URL`. If GitHub
   OAuth is enabled, also set its callback to
   `https://agentplan.app/api/auth/callback/github`; redeploy.
8. Verify public/private behavior, email verification/reset delivery, API
   private/no-store headers, `/.well-known/security.txt`, and the nonce CSP on the
   final domain.

Choose PlanetScale and Vercel regions in the same geography where possible.

## License

[MIT](LICENSE)
