#!/usr/bin/env node

import { spawnSync } from "node:child_process";

// Keep the scanner source excluded below: the patterns themselves resemble
// secrets. Matches are captured in memory and only redacted locations are
// printed, so CI can never echo a discovered credential value.
const pattern = [
  "gh[pousr]_[A-Za-z0-9]{20,}",
  "github_pat_[A-Za-z0-9_]{40,}",
  "sk-(proj-)?[A-Za-z0-9_-]{20,}",
  "sk-ant-[A-Za-z0-9_-]{20,}",
  "AKIA[0-9A-Z]{16}",
  "xox[baprs]-[A-Za-z0-9-]{20,}",
  "npm_[A-Za-z0-9]{30,}",
  "-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----",
  "postgres(ql)?://[^[:space:]]+:[^[:space:]@]+@",
  "(BETTER_AUTH_SECRET|CRON_SECRET|R2_SECRET_ACCESS_KEY|AUTH_EMAIL_WEBHOOK_SECRET)=[^[:space:]]{16,}",
].join("|");

function runGit(args) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed with status ${result.status}`);
  }
  return result.stdout;
}

const revisions = runGit(["rev-list", "--all"])
  .split(/\r?\n/)
  .filter(Boolean);
const findings = new Set();

function collect(result, label) {
  if (result.status === 1) return;
  if (result.status !== 0) {
    throw new Error(`git grep failed for ${label} with status ${result.status}`);
  }

  for (const line of result.stdout.split(/\r?\n/)) {
    if (
      !line ||
      line.includes("not-for-production") ||
      line.includes("development-only") ||
      line.includes("postgres://postgres:postgres@localhost") ||
      // Historical versions of CI embedded their detector regex in the YAML.
      (line.includes("R2_SECRET_ACCESS_KEY=.+") && line.includes("PRIVATE KEY"))
    ) {
      continue;
    }
    const match = line.match(/^([0-9a-f]+):(.+?):(\d+):/);
    const worktreeMatch = line.match(/^(.+?):(\d+):/);
    findings.add(
      match
        ? `${match[1].slice(0, 12)}:${match[2]}:${match[3]}`
        : label === "WORKTREE" && worktreeMatch
          ? `WORKTREE:${worktreeMatch[1]}:${worktreeMatch[2]}`
        : `${label}:unknown-location`,
    );
  }
}

for (const revision of revisions) {
  collect(
    spawnSync(
      "git",
      [
        "grep",
        "-nI",
        "-E",
        pattern,
        revision,
        "--",
        ".",
        ":(exclude)scripts/scan-secrets.mjs",
      ],
      { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
    ),
    revision.slice(0, 12),
  );
}

collect(
  spawnSync(
    "git",
    [
      "grep",
      "--untracked",
      "-nI",
      "-E",
      pattern,
      "--",
      ".",
      ":(exclude)scripts/scan-secrets.mjs",
    ],
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  ),
  "WORKTREE",
);

if (findings.size) {
  process.stderr.write("Potential credential material found at redacted locations:\n");
  for (const location of findings) process.stderr.write(`- ${location}\n`);
  process.exit(1);
}

process.stdout.write(
  `No credential patterns found in the working tree or ${revisions.length} reachable commits.\n`,
);
