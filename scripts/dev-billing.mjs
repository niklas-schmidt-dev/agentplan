import { spawn, spawnSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "dotenv";
import { checkoutIdentity, localEnvironment } from "./qa-environment.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const billing = parse(readFileSync(".data/polar-setup/sandbox.env"));
if (
  billing.POLAR_SERVER !== "sandbox" ||
  !billing.POLAR_ACCESS_TOKEN ||
  !billing.POLAR_WEBHOOK_SECRET ||
  !billing.POLAR_PRO_PRODUCT_IDS
) {
  throw new Error("Complete the Sandbox configuration in .data/polar-setup/sandbox.env first.");
}
execFileSync(process.execPath, ["scripts/qa.mjs", "setup"], { stdio: "inherit" });
const state = JSON.parse(readFileSync(".data/qa/environment.json", "utf8"));
const database = new URL(state.databaseUrl);
if (
  state.id !== checkoutIdentity(root) ||
  database.hostname !== "127.0.0.1" ||
  database.pathname !== "/agentplan_qa"
) {
  throw new Error("Expected this checkout's managed local dev/QA database.");
}
execFileSync("portless", ["alias", "agentplan-sandbox", new URL(state.url).port], {
  env: { ...process.env, PORTLESS_SYNC_HOSTS: "0" },
  stdio: "inherit",
});
if (spawnSync("localcan", ["status"], { stdio: "ignore" }).status !== 0) {
  execFileSync("localcan", ["start", "--detach"], { stdio: "inherit" });
}
const localUrl = "https://agentplan-sandbox.localhost";
const env = {
  ...localEnvironment(state, root),
  POLAR_SERVER: "sandbox",
  POLAR_ACCESS_TOKEN: billing.POLAR_ACCESS_TOKEN,
  POLAR_WEBHOOK_SECRET: billing.POLAR_WEBHOOK_SECRET,
  POLAR_PRO_PRODUCT_IDS: billing.POLAR_PRO_PRODUCT_IDS,
  BETTER_AUTH_URL: localUrl,
  NEXT_PUBLIC_APP_URL: localUrl,
};

// LocalCan reaches only the signed webhook route. The QA app and inbox stay local.
const gateway = http.createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"service":"agentplan-sandbox-webhooks"}');
    return;
  }
  if (request.method !== "POST" || request.url !== "/api/billing/webhooks") {
    response.writeHead(404);
    response.end();
    return;
  }
  const maxBytes = 256 * 1024;
  if (Number(request.headers["content-length"]) > maxBytes) {
    response.writeHead(413);
    response.end();
    request.resume();
    return;
  }
  const headers = {};
  for (const name of [
    "content-type",
    "content-length",
    "webhook-id",
    "webhook-timestamp",
    "webhook-signature",
  ]) {
    if (request.headers[name] !== undefined) headers[name] = request.headers[name];
  }
  // Buffer at most the route's payload limit, preserving the exact signed bytes.
  // Do not send a partial oversized request to the application.
  const chunks = [];
  let bytes = 0;
  request.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      chunks.length = 0;
      if (!response.headersSent) response.writeHead(413);
      response.end();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    if (response.writableEnded) return;
    const upstream = http.request(
      new URL("/api/billing/webhooks", state.url),
      { method: "POST", headers, timeout: 30000 },
      (result) => {
        response.writeHead(result.statusCode ?? 502, { "Content-Type": "application/json" });
        result.pipe(response);
      },
    );
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    response.on("close", () => upstream.destroy());
    upstream.end(Buffer.concat(chunks));
  });
});
gateway.headersTimeout = 10000;
gateway.requestTimeout = 30000;
await new Promise((resolve, reject) => {
  gateway.once("error", reject);
  gateway.listen(56619, "127.0.0.1", resolve);
});
const app = spawn(process.execPath, ["scripts/qa-server.mjs"], {
  cwd: root,
  env,
  stdio: "inherit",
});
const tunnelFile = path.join(os.homedir(), ".localcan/projects/agentplan-dev-webhooks.yml");
const savedTunnelFile = path.join(root, ".data/polar-setup/localcan.saved.yml");
function setTunnelEnabled(enabled) {
  const source = existsSync(tunnelFile)
    ? tunnelFile
    : existsSync(savedTunnelFile)
      ? savedTunnelFile
      : ".data/polar-setup/localcan.yml";
  let yaml = readFileSync(source, "utf8");
  if (
    !yaml.includes("target: http://127.0.0.1:56619") ||
    !yaml.includes("name: AgentPlan dev webhooks")
  ) {
    throw new Error("Unexpected LocalCan project; refusing to overwrite it.");
  }
  yaml = yaml.match(/^\s+enabled:/m)
    ? yaml.replace(/^(\s+)enabled:.*$/m, `$1enabled: ${enabled}`)
    : yaml.replace("        inspect: false", `        inspect: false\n        enabled: ${enabled}`);
  writeFileSync(tunnelFile, yaml, { mode: 0o600 });
  // LocalCan 1.2.0 keeps an existing connection when only enabled is toggled.
  // Unload this project on stop, preserving its reserved URL for the next run.
  if (!enabled) renameSync(tunnelFile, savedTunnelFile);
  execFileSync("localcan", ["reload"], { stdio: "ignore" });
}
try {
  setTunnelEnabled(true);
} catch (error) {
  gateway.close();
  app.kill("SIGTERM");
  throw error;
}
let stopped = false;
const stop = (signal) => {
  if (stopped) return;
  stopped = true;
  try {
    setTunnelEnabled(false);
  } finally {
    gateway.close();
    gateway.closeAllConnections();
    app.kill(signal);
  }
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
app.on("error", () => {
  stop("SIGTERM");
  process.exitCode = 1;
});
app.on("exit", (code) => {
  stop("SIGTERM");
  process.exitCode ||= code ?? 0;
});
try {
  let ready = false;
  const deadline = Date.now() + 120000;
  console.log("Waiting for the LocalCan webhook domain and TLS certificate…");
  while (Date.now() < deadline && !stopped) {
    const tunnels = JSON.parse(
      execFileSync("localcan", ["tunnel", "ls", "--json"], { encoding: "utf8" }),
    );
    const tunnel = tunnels.find((entry) => entry.project_id === "agentplan-dev-webhooks");
    if (tunnel) {
      try {
        const origin = `https://${tunnel.tunnel_url.replace(/^https:\/\//, "")}`;
        const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(3000) });
        ready = response.ok && (await response.json()).service === "agentplan-sandbox-webhooks";
      } catch {
        /* The connection may still be starting. */
      }
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready && !stopped)
    throw new Error(
      "LocalCan webhook tunnel is unavailable. Check its domain in the LocalCan dashboard; see .data/polar-setup/README.md.",
    );
  if (ready)
    console.log(
      `Local dev/QA: ${localUrl}\nCtrl-C stops this app, gateway, and its LocalCan tunnel.`,
    );
} catch (error) {
  stop("SIGTERM");
  console.error(error.message);
  process.exitCode = 1;
}
