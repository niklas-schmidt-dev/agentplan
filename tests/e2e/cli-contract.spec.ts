import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { publishingFixture } from "../browser/publishing";

async function withServer(
  handle: (req: IncomingMessage, res: ServerResponse, base: string) => Promise<void>,
  run: (base: string) => Promise<void>,
) {
  let base = "";
  const server = createServer((req, res) => {
    void handle(req, res, base).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server port");
  base = `http://127.0.0.1:${address.port}`;
  try {
    await run(base);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function runCli(args: string[], base: string, configRoot: string, input?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("packages/cli/dist/index.js"), ...args], {
      shell: false,
      timeout: 30_000,
      env: {
        ...process.env,
        FORCE_COLOR: undefined,
        NO_COLOR: undefined,
        AGENTPLAN_TOKEN: "ap_live_synthetic_contract",
        AGENTPLAN_API_URL: base,
        XDG_CONFIG_HOME: configRoot,
        APPDATA: configRoot,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(input);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function json(
  res: ServerResponse,
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

for (const bundle of [false, true]) {
  test(`shipped CLI recovers a lost ${bundle ? "bundle" : "file"} completion response without a duplicate or cancellation`, async () => {
    const configRoot = await mkdtemp(path.join(process.cwd(), ".data/qa/cli-contract-"));
    let created = 0;
    let cancelled = 0;
    let completed = 0;
    let files: Array<{ id: string; path: string; contentType: string; sizeBytes: number }> = [];
    const draft = {
      id: "draft-fixture",
      title: "Recovered",
      visibility: "private",
      version: 1,
      url: "https://example.com/p/recovered",
    };
    const version = { id: "version-fixture", version: 1, isBundle: bundle };
    try {
      await withServer(
        async (req, res, base) => {
          if (req.method === "DELETE") {
            cancelled++;
            res.writeHead(204);
            res.end();
            return;
          }
          if (req.url === "/storage") {
            for await (const chunk of req) void chunk;
            res.writeHead(200);
            res.end();
            return;
          }
          if (req.url?.endsWith("/complete")) {
            completed++;
            req.socket.destroy();
            return;
          }
          if (req.url?.endsWith("/targets")) {
            json(res, {
              targets: files.map((file) => ({
                fileId: file.id,
                uploaded: false,
                upload: { method: "PUT", url: `${base}/storage`, headers: {} },
              })),
            });
            return;
          }
          if (req.method === "POST") {
            created++;
            let raw = "";
            for await (const chunk of req) raw += String(chunk);
            const body = JSON.parse(raw);
            if (bundle)
              files = body.files.map((file: object, index: number) => ({
                ...file,
                id: `file-${index}`,
              }));
            json(res, {
              intent: { id: "intent-fixture", status: "pending" },
              files,
              upload: { method: "PUT", url: `${base}/storage`, headers: {} },
            });
            return;
          }
          json(res, {
            intent: { id: "intent-fixture", status: "completed" },
            draft,
            version,
            files,
          });
        },
        async (base) => {
          const result = await runCli(
            ["upload", publishingFixture(bundle ? "folder" : "plan.html"), "--json"],
            base,
            configRoot,
          );
          expect(result.code, result.stderr).toBe(0);
          expect(JSON.parse(result.stdout)).toEqual({ draft, version });
        },
      );
      expect({ created, completed, cancelled }).toEqual({ created: 1, completed: 1, cancelled: 0 });
    } finally {
      await rm(configRoot, { recursive: true, force: true });
    }
  });
}

test("shipped CLI paginates, verifies write-only login, and emits structured errors", async () => {
  const configRoot = await mkdtemp(path.join(process.cwd(), ".data/qa/cli-contract-"));
  const paths: string[] = [];
  try {
    await withServer(
      async (req, res) => {
        paths.push(req.url!);
        if (req.url === "/api/v1/identity") {
          json(res, { userId: "owner", scopes: ["drafts:write"] });
          return;
        }
        if (req.url === "/api/v1/drafts") {
          json(res, { drafts: [{ id: "one" }], nextCursor: "page-two" });
          return;
        }
        if (req.url === "/api/v1/drafts?cursor=page-two") {
          json(res, { drafts: [{ id: "two" }], nextCursor: null });
          return;
        }
        if (req.url === "/api/v1/drafts?limit=1") {
          json(res, { drafts: [{ id: "one" }], nextCursor: "page-two" });
          return;
        }
        json(res, { error: { code: "RATE_LIMITED", message: "Try later" } }, 429, {
          "x-request-id": "req-fixture",
          "retry-after": "7",
        });
      },
      async (base) => {
        const login = await runCli(["login"], base, configRoot);
        expect(login.code, login.stderr).toBe(0);
        expect(paths).toEqual(["/api/v1/identity"]);
        const listed = await runCli(["list", "--json"], base, configRoot);
        expect(listed.code, listed.stderr).toBe(0);
        expect(JSON.parse(listed.stdout).drafts).toEqual([{ id: "one" }, { id: "two" }]);
        const page = await runCli(["list", "--limit", "1", "--json"], base, configRoot);
        expect(JSON.parse(page.stdout)).toEqual({
          drafts: [{ id: "one" }],
          nextCursor: "page-two",
        });
        const rejected = await runCli(["get", "missing", "--json"], base, configRoot);
        expect(rejected.code).toBe(1);
        expect(rejected.stdout).toBe("");
        expect(JSON.parse(rejected.stderr).error).toEqual({
          code: "RATE_LIMITED",
          message: "Try later",
          status: 429,
          requestId: "req-fixture",
          retryAfter: "7",
        });
        const invalid = await runCli(["delete", "one", "--json"], base, configRoot);
        expect(invalid.code).toBe(2);
        expect(JSON.parse(invalid.stderr).error.code).toBe("INVALID_ARGUMENT");
        const before = paths.length;
        const validated = await runCli(
          ["validate", publishingFixture("folder"), "--json"],
          base,
          configRoot,
        );
        expect(validated.code, validated.stderr).toBe(0);
        expect(JSON.parse(validated.stdout).valid).toBe(true);
        expect(paths).toHaveLength(before);
      },
    );
  } finally {
    await rm(configRoot, { recursive: true, force: true });
  }
});
