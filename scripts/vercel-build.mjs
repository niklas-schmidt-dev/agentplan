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

// Neon's Vercel integration supplies DATABASE_URL_UNPOOLED, so a production
// deployment can safely apply committed migrations. Other installations may
// expose only a restricted/pooled runtime URL; never try DDL through that
// connection unless the operator explicitly opts in.
const shouldMigrate =
  process.env.VERCEL_ENV === "production" &&
  (Boolean(process.env.DATABASE_URL_UNPOOLED?.trim()) || process.env.AUTO_MIGRATE === "1");

if (shouldMigrate) {
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
} else if (process.env.VERCEL_ENV === "production") {
  process.stdout.write(
    "Skipping automatic migrations: connect Neon or set AUTO_MIGRATE=1 with a DDL-capable URL.\n",
  );
}

run("build");
