#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  normalizeBundlePath,
  selectBundleEntry,
  uploadSpecFor,
  validateBundleManifest,
  type UploadSpec,
} from "@agentplan/upload-contract";
import { AgentPlanApi, ApiError, DEFAULT_API_URL, type ApiDraft } from "./api.js";
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

async function inspectUploadFile(
  filePath: string,
): Promise<{ filename: string; sizeBytes: number; spec: UploadSpec }> {
  const filename = path.basename(filePath);
  let sizeBytes: number;
  try {
    sizeBytes = (await stat(filePath)).size;
  } catch {
    fail(`Cannot read ${filePath}.`, 2);
  }
  const spec = uploadSpecFor(filename, null);
  if (!spec) fail("Supported files are HTML, JPEG, PNG, WebP, GIF, AVIF, and MP4.", 2);
  if (sizeBytes === 0) fail("The file is empty.", 2);
  if (sizeBytes > spec.maxBytes) {
    fail(`The file exceeds the ${spec.maxBytes / (1024 * 1024)} MiB limit.`, 2);
  }
  return { filename, sizeBytes, spec };
}

async function uploadProviderFile(
  filePath: string,
  sizeBytes: number,
  upload: { method: string; url: string; headers: Record<string, string> },
): Promise<void> {
  const headers = new Headers(upload.headers);
  headers.set("content-length", String(sizeBytes));
  let response: Response;
  try {
    response = await fetch(upload.url, {
      method: upload.method,
      headers,
      body: createReadStream(filePath),
      redirect: "error",
      referrerPolicy: "no-referrer",
      credentials: "omit",
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  } catch (error) {
    throw new ApiError(0, "STORAGE_UPLOAD_FAILED", `Storage upload failed: ${String(error)}`);
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      "STORAGE_UPLOAD_FAILED",
      `Storage upload failed (${response.status}).`,
    );
  }
}

type LocalBundleFile = {
  absolutePath: string;
  path: string;
  contentType: string;
  sizeBytes: number;
};

const IGNORED_DIRECTORIES = new Set([".git", ".svn", ".hg", "node_modules"]);
const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db"]);

async function inspectBundleDirectory(
  root: string,
  explicitEntry?: string,
): Promise<{ entryPath: string; files: LocalBundleFile[] }> {
  const files: LocalBundleFile[] = [];
  const unsupported: string[] = [];

  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      fail(`Cannot read directory ${directory}.`, 2);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (
        (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) ||
        (entry.isFile() && IGNORED_FILES.has(entry.name))
      ) {
        continue;
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        fail(`Symlinks are not supported in bundles: ${relativePath}`, 2);
      }
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        unsupported.push(relativePath);
        continue;
      }
      const spec = uploadSpecFor(relativePath, null);
      if (!spec) {
        unsupported.push(relativePath);
        continue;
      }
      const metadata = await stat(absolutePath);
      files.push({
        absolutePath,
        path: normalizeBundlePath(relativePath),
        contentType: spec.contentType,
        sizeBytes: metadata.size,
      });
    }
  }

  await walk(root, "");
  if (unsupported.length) {
    fail(`Unsupported bundle files: ${unsupported.join(", ")}`, 2);
  }
  let entryPath: string;
  try {
    entryPath = selectBundleEntry(
      files.map((file) => file.path),
      explicitEntry,
    );
    const manifest = validateBundleManifest({
      entryPath,
      files: files.map((file) => ({
        path: file.path,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
      })),
    });
    entryPath = manifest.entryPath;
  } catch (error) {
    fail(error instanceof Error ? error.message : "Invalid HTML bundle.", 2);
  }
  return { entryPath, files };
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= values.length) return;
        await task(values[index]!);
      }
    }),
  );
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
    return await api.completeBundle(created.intent.id);
  } catch (error) {
    await api.cancelUploadIntent(created.intent.id).catch(() => undefined);
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
  if (spec.kind === "html" && flags.draft) {
    const bytes = new Uint8Array(await readFile(file));
    const result = await api.addVersion(flags.draft, bytes, filename);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      printDraft(result.draft, "Uploaded new version of");
    }
    return;
  }

  let result: { draft: ApiDraft; version?: unknown };
  if (spec.kind === "html") {
    const bytes = new Uint8Array(await readFile(file));
    result = await api.createDraft(bytes, filename, {
      title: flags.title,
      visibility,
      password,
    });
  } else {
    const intent = await api.createUploadIntent({
      filename,
      contentType: spec.contentType,
      sizeBytes,
      target: flags.draft
        ? { type: "draft", draftId: flags.draft }
        : {
            type: "new",
            title: flags.title,
            visibility,
            password,
          },
    });
    try {
      await uploadProviderFile(file, sizeBytes, intent.upload);
      result = await api.completeUploadIntent(intent.intent.id);
    } catch (error) {
      await api.cancelUploadIntent(intent.intent.id).catch(() => undefined);
      throw error;
    }
  }
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
      entry: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  const [command, argument] = positionals;
  if (values.help || !command) {
    process.stderr.write(USAGE);
    process.exit(values.help ? 0 : 2);
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
