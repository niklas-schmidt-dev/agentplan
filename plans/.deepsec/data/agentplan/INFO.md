# AgentPlan

## What this codebase does

AgentPlan is a Next.js App Router service and CLI for publishing user-supplied
HTML behind stable links. Browser users authenticate with Better Auth; agents
use scoped bearer tokens. Metadata lives in Postgres through Drizzle and HTML
objects live in a private Cloudflare R2 bucket, with a filesystem driver only
for local development and tests.

The service supports private, public, and password-protected drafts, immutable
version history, storage and upload quotas, rate limits, soft deletion, and a
cron-driven hard purge. The working snapshot also adds email/password signup,
first-user admin bootstrap, runtime signup policy, role management, and
administrator-driven user deletion.

## Auth shape

- `getOptionalUser`, `requireUser`, and `requireAdmin` are the browser-session
  primitives. Server Actions must call the appropriate helper before reading
  or changing tenant or administrator data.
- `authenticateApiRequest` accepts either a scope-checked API token or a
  browser session. `authenticateSession` is required for token-management
  routes so API tokens cannot mint or enumerate other tokens.
- `getDraftForOwner` performs ownership checks in the database query.
  `resolveDraftView` is the single authorization resolver for public,
  private, password-protected, and owner views.
- `evaluateSignup` decides whether signup is allowed and assigns the first
  account the admin role. `setUserRole` and `deleteUserCompletely` are
  privileged admin operations exposed only through `requireAdmin` actions.
- Password access uses a draft-scoped HMAC cookie whose signature is bound to
  the current password hash, so password rotation should revoke old grants.

## Threat model

The highest-impact failure is cross-tenant disclosure of private HTML, API
tokens, session credentials, or administrator data. Uploaded HTML is fully
hostile and may run scripts, so escaping the opaque iframe/content sandbox or
making authenticated same-origin requests is a primary boundary.

Attackers may also target first-admin creation, role changes, signup policy,
password brute force, upload/storage exhaustion, purge authorization, or
object lifecycle races. Public draft content is intentionally readable; draft
existence and protected titles should not leak before authorization.

## Project-specific patterns to flag

- Every `app/api/**/route.ts` mutation must authenticate server-side, validate
  input, and preserve owner or admin scope. Session fallback must not silently
  weaken bearer-token scope requirements.
- Every `"use server"` mutation must call `requireUser` or `requireAdmin`;
  hidden form fields and UI visibility are never authorization controls.
- The two hostile-document controls must remain equivalent: iframe `sandbox`
  attributes and the content response CSP `sandbox` directive must never add
  same-origin or top-navigation capabilities.
- R2 is always private. No route may expose a storage key, presigned object
  URL, or object bytes before `resolveDraftView` grants access.
- First-user admin assignment and quota/rate-limit checks must remain correct
  under concurrent serverless requests, not only sequential tests.

## Known false-positives

- `app/p/[slug]/content/route.ts` intentionally returns untrusted `text/html`;
  the response CSP sandbox and viewer iframe provide the isolation boundary.
- `lib/storage/fs.ts` writes files intentionally but is selected only outside
  production and constrains keys beneath its configured root.
- Security and E2E tests intentionally contain hostile HTML, malformed tokens,
  fake credentials, and attack-shaped strings.
- `.env.example` and CI contain placeholders or test-only secrets, never
  production credentials.
- `/`, `/healthz`, public-draft viewer routes, and Better Auth entry points are
  intentionally reachable without an AgentPlan session.
