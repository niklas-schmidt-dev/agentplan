# agentplan-cli

The official command-line client for [AgentPlan](https://agentplan.app). Publish
agent-generated HTML files behind stable, private-by-default links.

## Quick start

Run the CLI without installing it:

```bash
npx agentplan-cli login
npx agentplan-cli upload ./plan.html
```

Create an API token in the AgentPlan dashboard, then paste it into `login` when
prompted.

To install the `agentplan` command globally:

```bash
npm install --global agentplan-cli
agentplan login
```

## Commands

```text
agentplan login
agentplan logout
agentplan upload <file.html>
  --public | --private
  --password <password>
  --password-stdin
  --title <title>
  --draft <id>
  --json
agentplan list [--json]
agentplan open <id>
```

Authentication is resolved in this order:

1. `AGENTPLAN_TOKEN`
2. A token saved by `agentplan login`
3. An interactive token prompt

Set `AGENTPLAN_API_URL` to use a custom AgentPlan deployment. Custom endpoints
must use HTTPS, except for localhost development.

The CLI requires Node.js 20 or newer. Source code and issue tracking are
available in the [AgentPlan repository](https://github.com/niklas-schmidt-dev/agentplan).
