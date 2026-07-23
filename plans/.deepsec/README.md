# deepsec

This directory holds the [deepsec](https://www.npmjs.com/package/deepsec)
config for AgentPlan. Checked into git so teammates inherit
project context (auth shape, threat model, custom matchers); generated
scan output is gitignored.

Currently configured project: `agentplan`. Audit runs target the immutable,
ignored snapshot at `../.audit-work/snapshot-v2`, not a changing worktree.

## Setup

1. `pnpm install` — installs deepsec.
2. Add an AI Gateway / Anthropic / OpenAI token to `.env.local`. If
   you already have `claude` or `codex` CLI logged in on this
   machine, you can skip the token for non-sandbox runs (`process` /
   `revalidate` / `triage`); deepsec auto-detects and reuses the
   subscription. See
   `node_modules/deepsec/dist/docs/vercel-setup.md` after install.
3. Review `data/agentplan/SETUP.md` and keep
   `data/agentplan/INFO.md` synchronized with material trust-boundary changes.

## Daily commands

```bash
pnpm deepsec scan
pnpm deepsec process     --agent codex --model gpt-5.5 --thinking-level xhigh --concurrency 2
pnpm deepsec revalidate  --agent codex --model gpt-5.5 --thinking-level xhigh --min-severity MEDIUM
pnpm deepsec export      --format md-dir --out ./findings
```

Pass `--project-id agentplan` explicitly in automated audit commands.

`scan` is free (regex only). `process` is the AI stage (≈$0.30/file
on Opus by default). Run state goes to `data/agentplan/`.

## Adding another project

To scan another codebase from this same `.deepsec/`:

```bash
pnpm deepsec init-project ../some-other-package   # path relative to .deepsec/
```

Appends an entry to `deepsec.config.ts` and writes
`data/<id>/{INFO.md,SETUP.md,project.json}`. Open the new SETUP.md
in your agent to fill in INFO.md.

## Layout

```
deepsec.config.ts        Project list (one entry per scanned repo)
data/agentplan/
  INFO.md                Repo context — checked into git, hand-curated
  SETUP.md               Agent setup prompt — checked in, deletable
  project.json           Generated (gitignored)
  files/                 One JSON per scanned source file (gitignored)
  runs/                  Run metadata (gitignored)
  reports/               Generated markdown reports (gitignored)
AGENTS.md                Pointer for coding agents
.env.local               Tokens (gitignored)
```

## Docs

After `pnpm install`:

- Skill: `node_modules/deepsec/SKILL.md`
- Full docs: `node_modules/deepsec/dist/docs/{getting-started,configuration,models,writing-matchers,plugins,architecture,data-layout,vercel-setup,faq}.md`

Or browse on
[GitHub](https://github.com/vercel/deepsec/tree/main/docs).
