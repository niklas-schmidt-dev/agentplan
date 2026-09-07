# Local development and agent QA

## Start and inspect

```sh
npm ci
npx playwright install chromium
npm run qa:up
```

Use a local Docker context with Docker running (Postgres 17, matching CI).
If the selected context is remote or Docker is absent, QA uses `initdb` and
`pg_ctl` from PATH to create an isolated local cluster instead. Set
`QA_DATABASE_DRIVER=native` to select that backend explicitly; it uses your
installed PostgreSQL version. Remote Docker contexts are rejected by the Docker
backend because their loopback ports are not local.

With Docker, QA creates a Postgres 17 container labelled with a hash
of this checkout's absolute path, bound only to loopback. It chooses separate
app/database/inbox ports, applies committed migrations, builds the CLI, seeds
accounts/uploads, and serves the app. Database data is independent of your
normal database and other checkouts. Different checkouts can run simultaneously;
run one QA process at a time within a checkout (Next build output is shared).

The runner explicitly overrides the application environment, including cloud
storage, email, OAuth, URL, and database values from `.env` files. Local data and
credentials live in `.data/qa/`, which is ignored by Git:

| File                                                         | Purpose                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| `environment.json`                                           | Generated connection details; keep private                   |
| `accounts.json`                                              | Ordinary, admin, blocked, and nearly-full accounts/passwords |
| `drafts.json`                                                | Sample HTML, image, video, and bundle IDs and viewer URLs    |
| `cli.json`                                                   | Dedicated local API token, recreated by seeding              |
| `user-auth.json`, `admin-auth.json`, `nearly-full-auth.json` | Playwright storage states                                    |
| `artifacts/server.log`                                       | Local app output and structured upload diagnostics           |
| `artifacts/report/index.html`                                | Browser results, screenshots and traces                      |
| `artifacts/results.json`                                     | Machine-readable browser results                             |
| `artifacts/verification.json`                                | Completed full-check stages and exclusions                   |

Use the normal login form or load a saved storage state in a Playwright context.
Sessions are local and expire normally; `npm run qa:seed` refreshes fixtures while
`qa:up` is running. Seeding preserves existing sample drafts. The nearly-full
account reserves all but 1 KiB of its quota using a real pending upload; this
reservation expires after an hour, and reseeding renews it after expiry.

The inbox keeps at most 500 messages in memory and binds only to loopback.
Read `GET <inbox-url>/messages?to=<email>` to retrieve `{kind,to,name,url,from}`
messages. Open the `url` to complete verification or reset. The inbox disappears
when the app stops. Seeded accounts are already verified; the auth browser test
exercises actual email delivery and links for a fresh account.

## Lifecycle and checks

```sh
npm run qa:setup       # provision/migrate without starting the app
npm run qa:doctor      # redacted JSON: checkout, URLs, DB, migrations, pending uploads
npm run qa:e2e -- -g 'publishing'
npm run check:quick
npm run check:full
npm run qa:stop        # stop this checkout's Postgres after stopping the app
npm run qa:reset       # delete this checkout's labelled container and .data/qa
```

Stop `qa:up` with Ctrl-C before full checks or a browser run: Playwright launches
its own server and rejects an occupied port. Full checks use a separate
`agentplan_integration` database in the same container because existing
integration suites deliberately delete users. Browser tests use a third database, `agentplan_e2e`; seeded manual QA uses
`agentplan_qa`. `qa:e2e` provisions/migrates the browser database and builds the
CLI before running a targeted or complete browser suite.
The full command automatically sets `REQUIRE_DATABASE_TESTS=1`; a missing test
URL is an error. The opt-in live provider contract remains excluded and is
reported explicitly. `npm test` retains its lightweight database-optional behavior;
it is not the full completion gate. The legacy `npm run check` remains available.

For schema changes, generate migrations with the existing Drizzle commands and
then verify the committed migrations against a fresh QA container. `qa:reset`
verifies the container ownership label and removes no host volumes. The native backend stops only the cluster under
this checkout's `.data/qa/postgres` before removing its data. It refuses
to run while the QA app responds. Inspect evidence before resetting: reset also
removes this checkout's artifacts and fixture sessions.

## Debug a failed upload

1. Inspect the browser's failing response and its `x-request-id` header.
2. Search `artifacts/server.log` for that ID. Upload logs contain route template,
   method, status, duration, validated intent/file IDs, and allowlisted error
   types/codes. They omit request bodies, passwords, tokens, and signed URLs.
3. Follow the intent through create/transfer/complete using its UUID. The local
   database can be inspected through `qa:exec`; it points at QA, not production.
4. Open the Playwright report or `npx playwright show-trace <trace.zip>` to inspect
   browser actions and network responses. The runner retains the first failed
   attempt even when retries are disabled. Server logs redact query strings.

Traces and reports may contain test cookies, tokens and email links. Keep them
in trusted CI artifacts (seven-day retention), not public PR comments or public
AgentPlan uploads. Share screenshots that contain only synthetic data if needed.
`/healthz` is a liveness route; use `qa:doctor` for local dependency checks.

## Dedicated staging and provider acceptance

Local E2E uses the development server and filesystem storage. The full check
also compiles the production build, but production runtime, provider CORS,
callbacks and streaming need a deployed staging instance with real private
Vercel Blob or R2 storage. Filesystem storage remains disabled in production.

Create a dedicated staging deployment/database/bucket, migrate it, and create a
verified QA user through the normal signup flow. Grant that account enough quota
for smoke uploads. Configure the following environment variables privately:

- `QA_STAGING_URL`: exact HTTPS base URL.
- `QA_STAGING_EMAIL` and `QA_STAGING_PASSWORD`: dedicated QA account.
- `QA_STAGING_CONFIRM`: same URL; explicit target selection for upload/delete tests.

Run `npm run test:staging`. This suite signs in through the browser, uploads
synthetic fixtures using the actual controls, verifies rendering/seek behavior,
and deletes only drafts it created. It has no direct database access or local
server startup. Run it once per provider when changing storage behavior.

The manual **Staging QA** GitHub workflow uses the `qa-staging` GitHub environment.
Configure `QA_STAGING_URL` as an environment variable and the account credentials
as environment secrets. Configure any required deployment protection access in
the staging environment before running. Runtime logs and read-only DB access
should be scoped to that deployment; agents need the deployment name, log access
command, and test account, rather than production credentials.

For deeper provider changes, run the opt-in live storage contract with dedicated
provider credentials as described in `docs/media-uploads.md`. Its Node requests
cannot establish browser CORS. That document also covers long-duration streaming,
expiry, conditional reads, and delayed purge acceptance that a short smoke does
not prove. Staging credentials and provisioning are deployment-owned; no local
command creates cloud resources or modifies production settings.
