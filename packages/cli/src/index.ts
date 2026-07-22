#!/usr/bin/env node

const USAGE = `agentplan — publish agent-generated HTML behind stable links

Usage:
  agentplan upload <file> [--public|--private] [--title <title>] [--draft <id>] [--json]
  agentplan list [--json]
  agentplan open <id>
  agentplan login
  agentplan logout
`;

async function main(): Promise<number> {
  process.stderr.write(USAGE);
  process.stderr.write("\nThe CLI is under construction.\n");
  return 1;
}

main().then((code) => {
  process.exitCode = code;
});
