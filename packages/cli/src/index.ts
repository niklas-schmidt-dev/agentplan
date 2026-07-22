#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { AgentPlanApi, ApiError, DEFAULT_API_URL, type ApiDraft } from "./api.js";
import { clearConfig, loadConfig, saveConfig } from "./config.js";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

const USAGE = `agentplan — publish agent-generated HTML behind stable links

Usage:
  agentplan login                       store an API token (created in the dashboard)
  agentplan logout                      remove the stored token
  agentplan upload <file.html>          upload a new draft (private by default)
    --public | --private                set visibility
    --title <title>                     set the draft title
    --draft <id>                        add a version to an existing draft
    --json                              machine-readable output on stdout
  agentplan list [--json]               list your drafts
  agentplan open <id>                   open a draft in the browser

Environment:
  AGENTPLAN_TOKEN                       API token (takes precedence over stored login)
  AGENTPLAN_API_URL                     API base URL (default: ${DEFAULT_API_URL})
`;

function fail(message: string, exitCode = 1): never {
  process.stderr.write(`agentplan: ${message}\n`);
  process.exit(exitCode);
}

function apiUrl(config: { apiUrl?: string }): string {
  return (process.env.AGENTPLAN_API_URL ?? config.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
}

async function promptForToken(): Promise<string> {
  if (!process.stdin.isTTY) {
    fail("No API token. Set AGENTPLAN_TOKEN or run `agentplan login` in a terminal.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  process.stderr.write("Create a token in the dashboard: Settings → API tokens\n");
  const token = (await rl.question("Paste your API token: ")).trim();
  rl.close();
  if (!token.startsWith("ap_live_")) fail("That does not look like an AgentPlan token.");
  return token;
}

async function resolveApi(): Promise<AgentPlanApi> {
  const config = await loadConfig();
  const base = apiUrl(config);
  if (process.env.AGENTPLAN_TOKEN) return new AgentPlanApi(base, process.env.AGENTPLAN_TOKEN);
  if (config.token) return new AgentPlanApi(base, config.token);
  const token = await promptForToken();
  await saveConfig({ ...config, token });
  process.stderr.write("Token saved.\n");
  return new AgentPlanApi(base, token);
}

async function verifyToken(api: AgentPlanApi): Promise<void> {
  await api.listDrafts();
}

async function commandLogin(): Promise<void> {
  const config = await loadConfig();
  const token = await promptForToken();
  const api = new AgentPlanApi(apiUrl(config), token);
  await verifyToken(api);
  await saveConfig({ ...config, token });
  process.stderr.write("Logged in. Token verified and saved.\n");
}

async function commandLogout(): Promise<void> {
  await clearConfig();
  process.stderr.write("Logged out. Stored token removed.\n");
}

async function readHtmlFile(filePath: string): Promise<{ bytes: Uint8Array; filename: string }> {
  const filename = path.basename(filePath);
  if (!/\.html?$/i.test(filename)) fail("Only .html and .htm files are supported.", 2);
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    fail(`Cannot read ${filePath}.`, 2);
  }
  if (size === 0) fail("The file is empty.", 2);
  if (size > MAX_UPLOAD_BYTES) fail("The file exceeds the 2 MiB limit.", 2);
  return { bytes: new Uint8Array(await readFile(filePath)), filename };
}

function printDraft(draft: ApiDraft, action: string): void {
  process.stdout.write(
    `${action} ${draft.title}\nVisibility: ${draft.visibility}\nVersion: ${draft.version ?? "-"}\n${draft.url}\n`,
  );
}

async function commandUpload(
  file: string | undefined,
  flags: { public?: boolean; private?: boolean; title?: string; draft?: string; json?: boolean },
): Promise<void> {
  if (!file) fail("Usage: agentplan upload <file.html>", 2);
  if (flags.public && flags.private) fail("Use either --public or --private, not both.", 2);

  const { bytes, filename } = await readHtmlFile(file);
  const api = await resolveApi();

  if (flags.draft) {
    const result = await api.addVersion(flags.draft, bytes, filename);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      printDraft(result.draft, "Uploaded new version of");
    }
    return;
  }

  const result = await api.createDraft(bytes, filename, {
    title: flags.title,
    visibility: flags.public ? "public" : flags.private ? "private" : undefined,
  });
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    printDraft(result.draft, "Uploaded");
  }
}

async function commandList(flags: { json?: boolean }): Promise<void> {
  const api = await resolveApi();
  const result = await api.listDrafts();
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.drafts.length === 0) {
    process.stderr.write("No drafts yet. Upload one with `agentplan upload ./plan.html`.\n");
    return;
  }
  for (const draft of result.drafts) {
    process.stdout.write(
      `${draft.visibility.padEnd(7)} v${String(draft.version ?? "-").padEnd(3)} ${draft.title} — ${draft.url}\n`,
    );
  }
}

async function commandOpen(id: string | undefined): Promise<void> {
  if (!id) fail("Usage: agentplan open <id>", 2);
  const api = await resolveApi();
  const { draft } = await api.getDraft(id);
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(opener, [draft.url], { shell: process.platform === "win32", detached: true, stdio: "ignore" }).unref();
  process.stderr.write(`Opening ${draft.url}\n`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      public: { type: "boolean" },
      private: { type: "boolean" },
      title: { type: "string" },
      draft: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  const [command, argument] = positionals;
  if (values.help || !command) {
    process.stderr.write(USAGE);
    process.exit(command ? 0 : 2);
  }

  switch (command) {
    case "login":
      return commandLogin();
    case "logout":
      return commandLogout();
    case "upload":
      return commandUpload(argument, values);
    case "list":
      return commandList(values);
    case "open":
      return commandOpen(argument);
    default:
      process.stderr.write(USAGE);
      fail(`Unknown command: ${command}`, 2);
  }
}

main().catch((error: unknown) => {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      fail(`${error.message} Run \`agentplan login\` with a valid token.`);
    }
    fail(`${error.code}: ${error.message}`);
  }
  fail(error instanceof Error ? error.message : String(error));
});
