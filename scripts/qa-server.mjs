import { spawn } from "node:child_process";
import { mkdirSync, createWriteStream } from "node:fs";
import { startInbox } from "./qa-mail.mjs";

const app = new URL(process.env.QA_APP_URL ?? "http://localhost:3000");
const mail = new URL(process.env.QA_MAIL_URL ?? "http://127.0.0.1:3099");
const inbox = await startInbox(Number(mail.port), process.env.QA_MAIL_SECRET ?? "local-qa-mail");
const artifactDir = process.env.QA_ARTIFACT_DIR ?? ".data/qa/artifacts";
mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
const log = createWriteStream(`${artifactDir}/server.log`, { flags: "w", mode: 0o600 });
const child = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    app.port || "3000",
  ],
  {
    env: {
      ...process.env,
      AUTH_EMAIL_WEBHOOK_URL: mail.origin,
      AUTH_EMAIL_WEBHOOK_SECRET: process.env.QA_MAIL_SECRET ?? "local-qa-mail",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
// Next access logs contain reset/verification query tokens. Preserve diagnostics,
// but strip query strings and known credential shapes before writing artifacts.
function redact(value) {
  return value.replace(/\?[^\s"']+/g, "?[redacted]").replace(/ap_live_[A-Za-z0-9_-]+/g, "[token]");
}
for (const stream of [child.stdout, child.stderr]) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) {
      log.write(`${redact(line)}\n`);
      process.stdout.write(`${redact(line)}\n`);
    }
  });
  stream.on("end", () => {
    if (pending) log.write(redact(pending));
  });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  inbox.close();
  log.end();
  process.exitCode = code ?? 0;
});
