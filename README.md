# AgentPlan

Publish agent-generated static HTML documents behind stable, shareable links.

AgentPlan is a small service for AI agents (and their humans) that need to turn a
generated HTML file — a plan, a report, a dashboard — into a URL. Upload from the
browser, the API, or the CLI:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fniklas-schmidt-dev%2Fagentplan&project-name=agentplan&repository-name=agentplan&products=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22productSlug%22%3A%22neon%22%2C%22integrationSlug%22%3A%22neon%22%7D%2C%7B%22type%22%3A%22blob%22%7D%5D&envDescription=AgentPlan+needs+an+initial+admin+email%2C+an+auth+secret%2C+a+secure+email-delivery+webhook%2C+and+a+cron+secret.+Neon+and+Blob+are+provisioned+during+this+flow.&envLink=https%3A%2F%2Fgithub.com%2Fniklas-schmidt-dev%2Fagentplan%2Fblob%2Fmain%2Fdocs%2Fself-hosting.md%23required-values&env=ADMIN_BOOTSTRAP_EMAIL&env=BETTER_AUTH_SECRET&env=AUTH_EMAIL_WEBHOOK_URL&env=AUTH_EMAIL_WEBHOOK_SECRET&env=CRON_SECRET)

```bash
npx agentplan-cli upload ./plan.html
```

Every upload gets a stable link like `https://agentplan.app/p/launch-plan-x7k2`,
immutable version history, and owner-controlled visibility — `private` (owner
only, the default), `public` (anyone with the link), or `password` (anyone with
the link and the password).

## How it works

- **Next.js (App Router)** application deployed on Vercel with the Node.js runtime.
- **Postgres** with Drizzle ORM for drafts, versions, tokens, and audit events.
  The one-click deployment provisions Neon; PlanetScale Postgres and other
  compatible providers are supported.
- **Private object storage** for all uploaded HTML. The one-click deployment
  provisions private Vercel Blob; Cloudflare R2 remains available as an
  S3-compatible alternative. Visibility is enforced by the application, never
  by an object URL.
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
Browser ─┐                              ┌── Postgres (Neon by default)
         ├─ Next.js App Router (Vercel) ─┤
CLI / ───┘   • pages + server actions    └── Private object storage
Agents         • /api/v1 (token auth)
               • /p/{slug} sandboxed viewer
```

Request paths:

- **Browser** → same-origin API routes and small server actions → draft/token services
  → Postgres + private object storage. Upload rate reservations happen before
  multipart parsing.
  Authorization uses sessions and owner-scoped queries.
- **Agent / CLI** → `POST /api/v1/drafts` with `Authorization: Bearer ap_live_…` →
  scope-checked → same services.
- **Viewer** → `/p/{slug}` renders an iframe whose `src` is `/p/{slug}/content`; the
  content route re-authorizes server-side and streams the HTML from storage.

Key directories:

```text
app/            Routes: landing, dashboard, /p/[slug] viewer, /api/v1, /api/auth
components/     UI (auth buttons, dashboard widgets)
db/             Drizzle schema, pooled client, owner-scoped queries
drizzle/        Generated, committed SQL migrations
lib/
  auth/         Better Auth instance + session helpers (requireUser, getOptionalUser)
  drafts/       Upload/version/restore service + slug generation
  storage/      ObjectStorage interface: Vercel Blob, R2, and fs (dev/CI)
  tokens/        Token generation, hashing, bearer authentication
  api/           Request auth, response envelopes, serializers
  validation/    Zod schemas + upload validation
packages/cli/    The `agentplan-cli` npm package (`agentplan` executable)
tests/           unit / security / integration (Vitest) + e2e (Playwright)
```

## Local setup

Requirements: Node.js 24+, npm, and a Postgres instance.

1. `npm ci`
2. Copy `.env.example` to `.env` and fill in the database URL,
   `ADMIN_BOOTSTRAP_EMAIL`, Better Auth secret, storage configuration, and
   optional GitHub OAuth. Email/password development also needs an email webhook;
   without one, development suppresses delivery and an unverified account cannot
   sign in.
3. `npm run db:migrate` (prefers `DATABASE_URL_DIRECT` or
   `DATABASE_URL_UNPOOLED`)
4. `npm run dev`

For local development, set `STORAGE_DRIVER=fs` to store uploaded HTML on the
local filesystem. This driver is disabled in production.

### Quality gates

```bash
npm run check     # lint + typecheck + unit/security/integration tests + build
npm run test:e2e  # Playwright hostile-HTML browser tests (needs DATABASE_URL)
```

The test suite runs against a real Postgres database. Point `TEST_DATABASE_URL`
(unit/integration) or `DATABASE_URL` (e2e) at a disposable branch or local instance;
tests that require a database skip automatically when it is absent.

## CLI

The npm package is [`agentplan-cli`](https://www.npmjs.com/package/agentplan-cli);
the command it provides is `agentplan`.

Run it without installing:

```bash
npx agentplan-cli login
npx agentplan-cli upload ./plan.html
```

Or install the command globally:

```bash
npm install --global agentplan-cli
agentplan login
```

Once installed, the full command set is:

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

| Limit                          | Default                                          |
| ------------------------------ | ------------------------------------------------ |
| Upload size                    | 2 MiB per HTML file                              |
| Drafts per user                | 100                                              |
| Versions kept per draft        | 100 (oldest are pruned, uploads never hard-fail) |
| Total storage per user         | 250 MiB                                          |
| Active API tokens per user     | 25                                               |
| Uploads per user               | 30 / 10 min and 300 / day                        |
| Token create/revoke operations | 60 / hour and 200 / day                          |
| Draft password attempts        | 10 / 15 min per draft + IP                       |

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
- All HTML lives in private Vercel Blob or a private R2 bucket; visibility is an
  application-level decision enforced on every request. Private drafts return
  `404` to non-owners.
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

Use the Deploy Button above for the shortest path. It creates a Vercel project,
provisions Neon Postgres and Vercel Blob, and prompts for the remaining secrets.
Choose **Private** when creating the Blob store; AgentPlan intentionally fails
against a public store.

Committed database migrations run automatically on production Vercel builds.
Vercel's system hostname is used automatically until you configure
`BETTER_AUTH_URL` or `NEXT_PUBLIC_APP_URL` for a custom domain.

See [Self-hosting AgentPlan](docs/self-hosting.md) for the complete one-click
walkthrough, required email-webhook contract, non-Vercel instructions,
PlanetScale Postgres, and Cloudflare R2 configuration.

## License

[MIT](LICENSE)
