#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { AgentPlanApi, ApiError, DEFAULT_API_URL, type ApiDraft } from "./api.js";
import { clearConfig, loadConfig, saveConfig } from "./config.js";
import { hasNewDraftOnlyOptions, type UploadFlags } from "./upload-options.js";
import { isSafeHttpUrl, normalizeApiBaseUrl } from "./url.js";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

const USAGE = `agentplan — publish agent-generated HTML behind stable links

Usage:
  agentplan login                       store an API token (created in the dashboard)
  agentplan logout                      remove the stored token
  agentplan upload <file.html>          upload a new draft (private by default)
    --public | --private                set visibility
    --password <password>               protect the draft with a password
    --password-stdin                    read the draft password from stdin (safer)
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
  return normalizeApiBaseUrl(process.env.AGENTPLAN_API_URL ?? config.apiUrl ?? DEFAULT_API_URL);
}

async function hiddenLine(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    fail("A secure terminal is required. Set AGENTPLAN_TOKEN to read it from the environment.");
  }
  process.stderr.write(prompt);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.removeListener("data", onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: string | Buffer) => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u0003" || character === "\u0004") {
          cleanup();
          reject(new Error("Token entry cancelled."));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " " && character <= "~" && value.length < 512) value += character;
      }
    };
    input.on("data", onData);
  });
}

async function promptForToken(): Promise<string> {
  if (!process.stdin.isTTY) {
    fail("No API token. Set AGENTPLAN_TOKEN or run `agentplan login` in a terminal.");
  }
  process.stderr.write("Create a token in the dashboard: Settings → API tokens\n");
  const token = (await hiddenLine("Paste your API token: ")).trim();
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

async function readPasswordFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    fail("--password-stdin requires a pipe or redirected stdin.", 2);
  }
  process.stdin.setEncoding("utf8");
  let password = "";
  for await (const chunk of process.stdin) {
    password += chunk;
    if (password.length > 130) fail("The password exceeds the 128 character limit.", 2);
  }
  password = password.replace(/\r?\n$/, "");
  if (!password) fail("No password was provided on stdin.", 2);
  if (password.length > 128) fail("The password exceeds the 128 character limit.", 2);
  return password;
}

function printDraft(draft: ApiDraft, action: string): void {
  process.stdout.write(
    `${action} ${draft.title}\nVisibility: ${draft.visibility}\nVersion: ${draft.version ?? "-"}\n${draft.url}\n`,
  );
}

async function commandUpload(file: string | undefined, flags: UploadFlags): Promise<void> {
  if (!file) fail("Usage: agentplan upload <file.html>", 2);
  if (flags.password !== undefined && flags["password-stdin"]) {
    fail("Use only one of --password or --password-stdin.", 2);
  }
  const hasPasswordOption = flags.password !== undefined || flags["password-stdin"];
  const chosen = [flags.public, flags.private, hasPasswordOption].filter(Boolean).length;
  if (chosen > 1) {
    fail("Use only one of --public, --private, or a password option.", 2);
  }
  if (flags.draft && hasNewDraftOnlyOptions(flags)) {
    fail(
      "--draft only uploads a new version; visibility, password, and title options apply only when creating a draft.",
      2,
    );
  }
  const password = flags["password-stdin"] ? await readPasswordFromStdin() : flags.password;

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

  const visibility = flags.public
    ? "public"
    : password !== undefined
      ? "password"
      : flags.private
        ? "private"
        : undefined;
  const result = await api.createDraft(bytes, filename, {
    title: flags.title,
    visibility,
    password,
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
  // The URL comes from an HTTP response and is untrusted; refuse anything that
  // is not a plain, metacharacter-free http(s) URL before handing it to the OS.
  if (!isSafeHttpUrl(draft.url)) fail(`Server returned an unsafe URL: ${draft.url}`);
  const url = draft.url;

  // Never launch through a shell: pass the URL as a discrete argument so no
  // interpreter can act on its contents.
  const [opener, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  spawn(opener, args, { shell: false, detached: true, stdio: "ignore" }).unref();
  process.stderr.write(`Opening ${url}\n`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      public: { type: "boolean" },
      private: { type: "boolean" },
      password: { type: "string" },
      "password-stdin": { type: "boolean" },
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
