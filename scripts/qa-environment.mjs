import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export function checkoutIdentity(root = process.cwd()) {
  return createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12);
}

/** Explicit empty overrides keep Next's .env files out of the disposable app. */
/** @returns {Record<string, string | undefined>} */
export function localEnvironment(state, root = process.cwd()) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^(DATABASE_|TEST_DATABASE_|BETTER_AUTH_|AUTH_|RESEND_|GITHUB_CLIENT_|BLOB_|R2_|VERCEL|AP_|STORAGE_|AGENTPLAN_|PLAYWRIGHT_|QA_|CRON_SECRET|NEXT_PUBLIC_)/.test(
        key,
      )
    )
      delete env[key];
  }
  for (const line of readFileSync(path.join(root, ".env.example"), "utf8").split("\n")) {
    const key = line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1];
    if (key) env[key] = "";
  }
  // Limit overrides are documented in comments, so .env.example assignments
  // alone do not prevent Next from loading them from .env.local.
  for (const key of readFileSync(path.join(root, "lib/limits/plans.ts"), "utf8").match(
    /AP_[A-Z0-9_]+/g,
  ) ?? [])
    env[key] = "";
  return {
    ...env,
    NODE_ENV: "development",
    DATABASE_URL: state.databaseUrl,
    DATABASE_URL_DIRECT: state.databaseUrl,
    DATABASE_URL_UNPOOLED: state.databaseUrl,
    TEST_DATABASE_URL: state.databaseUrl,
    BETTER_AUTH_SECRET: state.authSecret,
    BETTER_AUTH_URL: state.url,
    NEXT_PUBLIC_APP_URL: state.url,
    ADMIN_BOOTSTRAP_EMAIL: "admin@qa.example.test",
    STORAGE_DRIVER: "fs",
    STORAGE_FS_ROOT: path.join(root, ".data/qa/storage"),
    QA_MAIL_URL: state.mailUrl,
    AUTH_EMAIL_WEBHOOK_URL: state.mailUrl,
    AUTH_EMAIL_WEBHOOK_SECRET: state.mailSecret,
    QA_MAIL_SECRET: state.mailSecret,
    QA_RUN_ID: state.id,
    QA_APP_URL: state.url,
    QA_ARTIFACT_DIR: path.join(root, ".data/qa/artifacts"),
    NEXT_TELEMETRY_DISABLED: "1",
    LIVE_STORAGE_CONTRACT: "0",
  };
}
