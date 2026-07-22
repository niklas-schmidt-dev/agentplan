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
- **Better Auth** with GitHub OAuth for browser sessions; scoped API tokens
  (`ap_live_…`, stored as SHA-256 hashes) for agents and the CLI.
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

- **Browser** → server actions (`app/dashboard/actions.ts`) → draft/token services →
  Postgres + R2. Authorization via `requireUser()` and owner-scoped queries.
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
2. Copy `.env.example` to `.env` and fill in values (PlanetScale URLs, GitHub OAuth
   app, Better Auth secret, R2 credentials). The landing page renders without any secrets.
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
agentplan upload ./plan.html --password hunter2   # password-protected
agentplan upload ./plan.html --title "Launch plan"
agentplan upload ./plan.html --draft <id>   # add a new version to an existing draft
agentplan upload ./plan.html --json      # machine-readable output on stdout
agentplan list [--json]
agentplan open <id>
```

Authentication precedence: `AGENTPLAN_TOKEN` → stored login → interactive prompt.
Tokens are stored in the OS configuration directory (`~/.config/agentplan` on Linux/macOS)
with owner-only permissions. `--json` writes only JSON to stdout; diagnostics go to
stderr; missing or revoked tokens exit non-zero.

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
- Only `.env.example` placeholders are committed; CI scans every push for secrets.

## Deployment (Vercel)

Production deployment is a deliberate, credentialed step. Runbook:

1. Import the public GitHub repo into Vercel; enable Fluid Compute.
2. Create a **private** Cloudflare R2 bucket and an S3 API token scoped to it.
3. In PlanetScale, create a **restricted application role** (not the admin role) and
   use its PgBouncer (pooled) URL for `DATABASE_URL`; keep the direct URL for
   migrations only.
4. Configure production env vars in Vercel: `DATABASE_URL`, `DATABASE_URL_DIRECT`,
   `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
   `NEXT_PUBLIC_APP_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_BUCKET`.
5. Run migrations against production using the direct URL: `npm run db:migrate`.
6. Deploy, verify auth on the Vercel domain, then attach `agentplan.app` and redirect
   `www` → apex.
7. Set the GitHub OAuth callback to `https://agentplan.app/api/auth/callback/github`
   and update `BETTER_AUTH_URL` / `NEXT_PUBLIC_APP_URL`; redeploy.
8. Verify public/private behavior on the final domain.

Choose PlanetScale and Vercel regions in the same geography where possible.

## License

[MIT](LICENSE)
