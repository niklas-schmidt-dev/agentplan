# Working in AgentPlan

Use `npm run qa:up` for an isolated local app with Postgres, sample accounts,
private filesystem storage, and a verification/reset inbox. Requires Node 24+
(recommended to match CI), npm dependencies, local Docker (or `initdb`/`pg_ctl`), and Playwright Chromium.
The command prints the URL; inspect `.data/qa/accounts.json` and `drafts.json`
for fixtures. Read `docs/agent-workflow.md` for environment lifecycle, debugging,
email links, provider QA, or a failed check.

## Verification

- `npm run check:quick`: lint, app/CLI types, unit/security tests; no database.
- `npm run check:full`: isolated migrations, lint, types, real database tests,
  CLI build, production build, and browser/CLI journeys. Stop `qa:up` first.
- For a targeted browser run: `npm run qa:e2e -- -g 'pattern'`.
- Upload/viewer/auth changes need the relevant browser journey. CLI changes need
  the built-executable journey. Storage/CSP/deployment changes also need the
  dedicated staging smoke described in `docs/agent-workflow.md`.
- Report which checks ran, passed, skipped, or could not run. Local filesystem
  tests do not establish provider CORS or production streaming behavior.

## Boundaries

Authorization belongs in server-side services and owner-scoped queries.
Read `SECURITY.md` before changing uploads, viewers, tokens, or moderation.
Uploaded HTML stays inside its sandbox; preserve immediate access revocation
and immutable version URLs. Keep public API error codes stable.

`packages/upload-contract` is shared by browser and CLI uploads. Root TypeScript
excludes packages; run the CLI typecheck/build when changing shared contracts.
Commit generated SQL migrations alongside schema changes.

Use the managed QA database for tests: integration suites delete accounts and
change global settings. Keep environment files, saved browser sessions, inbox
links, tokens, and trace artifacts in ignored `.data/`; artifacts can contain
credentials. Request IDs link upload responses to structured server logs.
