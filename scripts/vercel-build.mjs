#!/usr/bin/env node

import { spawnSync } from "node:child_process";

function run(script) {
  const result = spawnSync("npm", ["run", script], {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// The Deploy Button's first deployment is a production deployment. Applying
// committed Drizzle migrations here makes that deployment usable immediately.
// Preview builds intentionally do not mutate a shared production database.
if (process.env.VERCEL_ENV === "production") {
  const migrationUrl = [
    process.env.DATABASE_URL_DIRECT,
    process.env.DATABASE_URL_UNPOOLED,
    process.env.DATABASE_URL,
  ].find((value) => value?.trim());
  if (!migrationUrl) {
    throw new Error(
      "A database URL is required for production migrations. Connect Neon or set DATABASE_URL.",
    );
  }
  run("db:migrate");
}

run("build");
