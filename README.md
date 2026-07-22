# AgentPlan

Publish agent-generated static HTML documents behind stable, shareable links.

AgentPlan is a small service for AI agents (and their humans) that need to turn a
generated HTML file — a plan, a report, a dashboard — into a URL. Upload from the
browser, the API, or the CLI:

```bash
npx agentplan upload ./plan.html
```

Every upload gets a stable link like `https://agentplan.app/p/launch-plan-x7k2`,
immutable version history, and owner-controlled `public` / `private` visibility
(private is the default).

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

## Repository layout

```text
app/            Next.js App Router application (pages + API routes)
components/     UI components
db/             Drizzle schema, client, and query helpers
drizzle/        Generated SQL migrations
lib/            Auth, storage, tokens, validation, security helpers
packages/cli/   The `agentplan` CLI (npm workspace)
tests/          Unit, integration, and security tests
```

## Local setup

1. `npm ci`
2. Copy `.env.example` to `.env` and fill in values (PlanetScale URLs, GitHub OAuth
   app, Better Auth secret, R2 credentials). The landing page renders without any secrets.
3. `npm run db:migrate` (uses `DATABASE_URL_DIRECT`)
4. `npm run dev`

Quality gates:

```bash
npm run check   # lint + typecheck + unit tests + build
npm run test:e2e
```

## Security

See [SECURITY.md](SECURITY.md) for the threat model and how to report vulnerabilities.

## License

[MIT](LICENSE)
