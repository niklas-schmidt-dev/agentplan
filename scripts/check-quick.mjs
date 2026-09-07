import { spawnSync } from "node:child_process";
for (const args of [
  ["run", "lint"],
  ["run", "typecheck"],
  ["run", "typecheck", "-w", "agentplan-cli"],
  ["exec", "vitest", "run", "tests/unit", "tests/security"],
]) {
  const result = spawnSync("npm", args, {
    stdio: "inherit",
    env: {
      ...process.env,
      TEST_DATABASE_URL: "",
      DATABASE_URL: "",
      LIVE_STORAGE_CONTRACT: "0",
      REQUIRE_DATABASE_TESTS: "",
    },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(
  "Quick checks passed. Database, browser, production build, and provider checks were not run. Use npm run check:full for local application verification.",
);
