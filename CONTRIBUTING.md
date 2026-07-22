# Contributing to AgentPlan

Thanks for your interest in contributing!

## Development setup

Requirements: Node.js 24+ and npm.

```bash
npm ci
cp .env.example .env   # fill in what you need; the landing page needs no secrets
npm run dev
```

Database work needs a Postgres instance (PlanetScale branch or local Postgres).
Point `DATABASE_URL` (pooled) and `DATABASE_URL_DIRECT` (direct) at it, then run
`npm run db:migrate`.

## Quality gates

All of these must pass before a PR is merged (CI runs them too):

```bash
npm run check      # lint + typecheck + unit tests + build
npm run test:e2e   # Playwright
```

## Ground rules

- Never commit secrets. Only `.env.example` placeholders belong in the repo —
  check your staged files before every commit.
- Uploaded HTML is hostile input. Never render it into the application DOM and
  never serve it without the iframe sandbox. Read [SECURITY.md](SECURITY.md)
  before touching the upload or viewer paths.
- Authorization decisions live server-side, in query/service functions — not in
  client components.
- Keep API error codes stable; agents depend on them.
- TypeScript strict mode; avoid `any`.

## Workflow

1. Branch from `main`.
2. Make your change with tests.
3. Run the quality gates.
4. Open a PR describing what changed and why.
