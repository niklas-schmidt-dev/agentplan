#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { AgentPlanApi, ApiError, DEFAULT_API_URL, type ApiDraft } from "./api.js";
import { inspectUploadFile, inspectBundleDirectory, validateArtifact } from "./inspect.js";
import { CliError, writeError } from "./errors.js";
import { completeWithRecovery } from "./reconcile.js";
import { uploadProviderFile } from "./upload.js";
import { clearConfig, loadConfig, saveConfig } from "./config.js";
import { hasNewDraftOnlyOptions, type UploadFlags } from "./upload-options.js";
import { isSafeHttpUrl, normalizeApiBaseUrl } from "./url.js";

const USAGE = `agentplan — publish HTML, images, and MP4 behind stable links

Usage:
  agentplan login                       store an API token (created in the dashboard)
  agentplan logout                      remove the stored token
  agentplan upload <file|directory>     upload a draft or bundled HTML plan
    --public | --private                set visibility
    --password <password>               protect the draft with a password
    --password-stdin                    read the draft password from stdin (safer)
    --title <title>                     set the draft title
    --draft <id>                        add a version to an existing draft
    --entry <path>                      choose the bundle entry HTML
    --json                              machine-readable output on stdout
  agentplan validate <file|directory>   check an artifact offline [--entry <path>] [--json]
  agentplan list [--json]               list all your drafts
    --limit <1-200> | --cursor <cursor>  return one page with nextCursor
    --search <text> --visibility <mode> filter drafts
  agentplan get <id> [--json]           inspect a draft
  agentplan versions <id> [--json]      list immutable versions
  agentplan update <id>                 change title or audience
    --title <title> --public | --private | --password-stdin
  agentplan restore <id> <version-id>   restore as a new version
  agentplan delete <id> --yes           delete a draft
  agentplan upload-status <intent-id>   inspect/retry completion [--bundle] [--complete] [--json]
  agentplan open <id>                   open a draft in the browser

Environment:
  AGENTPLAN_TOKEN                       API token (takes precedence over stored login)
  AGENTPLAN_API_URL                     API base URL (default: ${DEFAULT_API_URL})
`;

function fail(message: string, exitCode = 1): never {
  throw new CliError(message, exitCode);
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
  const api = new AgentPlanApi(base, token);
  await verifyToken(api);
  await saveConfig({ ...config, token });
  process.stderr.write("Token saved.\n");
  return api;
}

async function verifyToken(api: AgentPlanApi): Promise<void> {
  await api.identity();
}

async function commandLogin(): Promise<void> {
  const config = await loadConfig();
  const token = process.env.AGENTPLAN_TOKEN || (await promptForToken());
  const api = new AgentPlanApi(apiUrl(config), token);
  await verifyToken(api);
  await saveConfig({ ...config, token });
  process.stderr.write("Logged in. Token verified and saved.\n");
}

async function commandLogout(): Promise<void> {
  await clearConfig();
  process.stderr.write("Logged out. Stored token removed.\n");
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (!failed) {
        const index = cursor++;
        if (index >= values.length) return;
        try {
          await task(values[index]!);
        } catch (error) {
          failed = true;
          failure ??= error;
        }
      }
    }),
  );
  if (failed) throw failure;
}

async function uploadBundle(
  api: AgentPlanApi,
  directory: string,
  flags: UploadFlags,
  visibility: "public" | "private" | "password",
  password?: string,
): Promise<{ draft: ApiDraft; version?: unknown }> {
  const local = await inspectBundleDirectory(directory, flags.entry);
  const created = await api.createBundle({
    entryPath: local.entryPath,
    files: local.files.map((file) => ({
      path: file.path,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
    })),
    target: flags.draft
      ? { type: "draft", draftId: flags.draft }
      : {
          type: "new",
          title: flags.title,
          visibility,
          password,
        },
  });
  const localByPath = new Map(local.files.map((file) => [file.path, file]));
  let completionStarted = false;
  try {
    for (let offset = 0; offset < created.files.length; offset += 10) {
      const batch = created.files.slice(offset, offset + 10);
      const issued = await api.issueBundleTargets(
        created.intent.id,
        batch.map((file) => file.id),
      );
      await mapWithConcurrency(issued.targets, 4, async (target) => {
        if (target.uploaded) return;
        if (!target.upload) {
          throw new ApiError(409, "UPLOAD_TARGET_MISSING", "No upload target was returned.");
        }
        const remote = batch.find((file) => file.id === target.fileId);
        const file = remote ? localByPath.get(remote.path) : undefined;
        if (!remote || !file) {
          throw new ApiError(400, "BUNDLE_FILE_MISSING", "The local bundle changed during upload.");
        }
        try {
          await uploadProviderFile(file.absolutePath, file.sizeBytes, target.upload);
        } catch (error) {
          const status = await api.getBundle(created.intent.id).catch(() => null);
          if (!status?.files.find((candidate) => candidate.id === target.fileId)?.uploaded) {
            throw error;
          }
        }
      });
    }
    completionStarted = true;
    return await completeWithRecovery(
      created.intent.id,
      () => api.completeBundle(created.intent.id),
      () => api.getBundle(created.intent.id),
    );
  } catch (error) {
    if (!completionStarted) await api.cancelUploadIntent(created.intent.id).catch(() => undefined);
    throw error;
  }
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
  if (!file) fail("Usage: agentplan upload <file>", 2);
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

  const api = await resolveApi();
  const fileMetadata = await lstat(file).catch(() => null);
  if (!fileMetadata) fail(`Cannot read ${file}.`, 2);
  if (fileMetadata.isSymbolicLink()) fail("Upload targets cannot be symlinks.", 2);

  const visibility: "public" | "private" | "password" = flags.public
    ? "public"
    : password !== undefined
      ? "password"
      : "private";

  if (fileMetadata.isDirectory()) {
    const result = await uploadBundle(api, file, flags, visibility, password);
    if (flags.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else printDraft(result.draft, flags.draft ? "Uploaded new version of" : "Uploaded");
    return;
  }
  if (!fileMetadata.isFile()) fail("Upload target must be a regular file or directory.", 2);
  if (flags.entry) fail("--entry can only be used with a directory upload.", 2);

  const { filename, sizeBytes, spec } = await inspectUploadFile(file);
  const intent = await api.createUploadIntent({
    filename,
    contentType: spec.contentType,
    sizeBytes,
    target: flags.draft
      ? { type: "draft", draftId: flags.draft }
      : { type: "new", title: flags.title, visibility, password },
  });
  let result: { draft: ApiDraft; version?: unknown };
  let completionStarted = false;
  try {
    await uploadProviderFile(file, sizeBytes, intent.upload);
    completionStarted = true;
    result = await completeWithRecovery(
      intent.intent.id,
      () => api.completeUploadIntent(intent.intent.id),
      () => api.getUploadIntent(intent.intent.id),
    );
  } catch (error) {
    if (!completionStarted) await api.cancelUploadIntent(intent.intent.id).catch(() => undefined);
    throw error;
  }
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    printDraft(result.draft, flags.draft ? "Uploaded new version of" : "Uploaded");
  }
}

async function commandList(flags: {
  json?: boolean;
  limit?: string;
  cursor?: string;
  search?: string;
  visibility?: string;
}): Promise<void> {
  const limit = flags.limit === undefined ? undefined : Number(flags.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200))
    fail("--limit must be an integer from 1 to 200.", 2);
  if (flags.visibility && !["public", "private", "password"].includes(flags.visibility))
    fail("--visibility must be public, private, or password.", 2);
  const api = await resolveApi();
  const options = {
    limit,
    cursor: flags.cursor,
    search: flags.search,
    visibility: flags.visibility,
  };
  const result = await api.listDrafts(options);
  const seen = new Set<string>();
  while (result.nextCursor && flags.limit === undefined && flags.cursor === undefined) {
    if (seen.has(result.nextCursor))
      throw new ApiError(200, "BAD_RESPONSE", "The API repeated a pagination cursor.");
    seen.add(result.nextCursor);
    const next = await api.listDrafts({ ...options, cursor: result.nextCursor });
    result.drafts.push(...next.drafts);
    result.nextCursor = next.nextCursor;
  }
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

async function commandValidate(
  target: string | undefined,
  flags: { json?: boolean; entry?: string },
): Promise<void> {
  if (!target) fail("Usage: agentplan validate <file|directory> [--entry <path>] [--json]", 2);
  const result = await validateArtifact(target, flags.entry);
  if (flags.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    process.stdout.write(
      `${result.valid ? "PASS" : "FAIL"}: ${result.files.length} file(s), ${result.totalSizeBytes} bytes.\n${result.limitations}\n`,
    );
    for (const issue of result.issues)
      process.stdout.write(`${issue.path}: ${issue.code}: ${issue.message}\n`);
  }
  if (!result.valid) process.exitCode = 2;
}

async function commandLifecycle(
  command: string,
  id: string | undefined,
  versionId: string | undefined,
  flags: UploadFlags & { yes?: boolean; bundle?: boolean; complete?: boolean },
): Promise<void> {
  if (!id) fail(`Usage: agentplan ${command} <id>`, 2);
  if (command === "restore" && !versionId)
    fail("Usage: agentplan restore <draft-id> <version-id>", 2);
  if (command === "delete" && !flags.yes)
    fail("Deletion requires --yes: agentplan delete <id> --yes", 2);
  let patch: { title?: string; visibility?: ApiDraft["visibility"]; password?: string } = {};
  if (command === "update") {
    if (flags.password !== undefined)
      fail(
        "Use --password-stdin to change a password without exposing it in process arguments.",
        2,
      );
    if ([flags.public, flags.private, flags["password-stdin"]].filter(Boolean).length > 1)
      fail("Use only one visibility or password option.", 2);
    patch = {
      ...(flags.title !== undefined ? { title: flags.title } : {}),
      ...(flags.public ? { visibility: "public" } : flags.private ? { visibility: "private" } : {}),
      ...(flags["password-stdin"] ? { password: await readPasswordFromStdin() } : {}),
    };
    if (!Object.keys(patch).length)
      fail("Provide --title, --public, --private, or --password-stdin.", 2);
  }
  const api = await resolveApi();
  if (command === "versions") {
    const result = await api.listVersions(id);
    if (flags.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else
      for (const version of result.versions)
        process.stdout.write(`v${version.version} ${version.id} ${version.url}\n`);
    return;
  }
  if (command === "upload-status") {
    const readStatus = () => (flags.bundle ? api.getBundle(id) : api.getUploadIntent(id));
    const status = await readStatus();
    const result =
      flags.complete && status.intent.status !== "completed"
        ? {
            ...status,
            ...(await completeWithRecovery(
              id,
              () => (flags.bundle ? api.completeBundle(id) : api.completeUploadIntent(id)),
              readStatus,
            )),
            intent: { ...status.intent, status: "completed" },
          }
        : status;
    if (flags.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else if (result.draft) printDraft(result.draft, "Uploaded");
    else process.stdout.write(`${result.intent.id}: ${result.intent.status}\n`);
    return;
  }
  if (command === "delete") {
    await api.deleteDraft(id);
    process.stdout.write(
      flags.json ? `${JSON.stringify({ deleted: true, id })}\n` : `Deleted ${id}\n`,
    );
    return;
  }
  const result =
    command === "get"
      ? await api.getDraft(id)
      : command === "restore"
        ? await api.restoreVersion(id, versionId!)
        : await api.updateDraft(id, patch);
  if (flags.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else
    printDraft(
      result.draft,
      command === "restore" ? "Restored" : command === "update" ? "Updated" : "Draft",
    );
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
      entry: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      limit: { type: "string" },
      cursor: { type: "string" },
      search: { type: "string" },
      visibility: { type: "string" },
      yes: { type: "boolean" },
      bundle: { type: "boolean" },
      complete: { type: "boolean" },
    },
    allowPositionals: true,
  });

  const [command, argument, versionId] = positionals;
  if (values.help || !command) {
    process.stderr.write(USAGE);
    process.exit(values.help ? 0 : 2);
  }

  const allowed: Record<string, string[]> = {
    login: [],
    logout: [],
    upload: ["public", "private", "password", "password-stdin", "title", "draft", "entry"],
    list: ["limit", "cursor", "search", "visibility"],
    open: [],
    validate: ["entry"],
    get: [],
    versions: [],
    update: ["title", "public", "private", "password", "password-stdin"],
    restore: [],
    delete: ["yes"],
    "upload-status": ["bundle", "complete"],
  };
  if (!allowed[command]) fail(`Unknown command: ${command}`, 2);
  for (const key of Object.keys(values)) {
    if (!["json", "help", ...allowed[command]].includes(key))
      fail(`--${key} is not supported for ${command}.`, 2);
  }
  const maxArguments =
    command === "restore" ? 3 : ["login", "logout", "list"].includes(command) ? 1 : 2;
  if (positionals.length > maxArguments) fail(`Too many arguments for ${command}.`, 2);
  switch (command) {
    case "login":
      return commandLogin();
    case "logout":
      return commandLogout();
    case "upload":
      return commandUpload(argument, values);
    case "list":
      return commandList(values);
    case "validate":
      return commandValidate(argument, values);
    case "get":
    case "versions":
    case "update":
    case "restore":
    case "delete":
    case "upload-status":
      return commandLifecycle(command, argument, versionId, values);
    case "open":
      return commandOpen(argument);
    default:
      process.stderr.write(USAGE);
      fail(`Unknown command: ${command}`, 2);
  }
}

main().catch((error: unknown) => {
  process.exitCode = writeError(error, process.argv.includes("--json"));
});
