import { defineConfig, devices } from "@playwright/test";

const baseURL =
  process.env.QA_APP_URL ?? process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const mailURL = process.env.QA_MAIL_URL ?? "http://127.0.0.1:3099";
const artifacts = process.env.QA_ARTIFACT_DIR ?? ".data/qa/artifacts";
// The runner and app must agree on both auth origin and database. Tests mutate
// accounts directly; remote QA belongs to the separate staging configuration.
if (!process.env.DATABASE_URL)
  throw new Error("E2E requires a disposable DATABASE_URL. Run npm run check:full.");
if (!["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname))
  throw new Error("Use test:staging for remote QA; local E2E mutates its database.");
process.env.PLAYWRIGHT_BASE_URL = baseURL;
process.env.QA_MAIL_URL = mailURL;
process.env.ADMIN_BOOTSTRAP_EMAIL ??= "e2e-bootstrap@example.test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [
    [process.env.CI ? "github" : "list"],
    ["html", { outputFolder: `${artifacts}/report`, open: "never" }],
    ["json", { outputFile: `${artifacts}/results.json` }],
  ],
  outputDir: `${artifacts}/test-results`,
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node scripts/qa-server.mjs",
    url: `${baseURL}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      QA_APP_URL: baseURL,
      QA_MAIL_URL: mailURL,
      QA_MAIL_SECRET: process.env.QA_MAIL_SECRET ?? "local-qa-mail",
      QA_ARTIFACT_DIR: artifacts,
      STORAGE_DRIVER: "fs",
      STORAGE_FS_ROOT: process.env.STORAGE_FS_ROOT ?? ".data/e2e-storage",
      DATABASE_URL: process.env.DATABASE_URL,
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET || "e2e-secret-not-for-production-0000",
      BETTER_AUTH_URL: baseURL,
      NEXT_PUBLIC_APP_URL: baseURL,
      ADMIN_BOOTSTRAP_EMAIL: process.env.ADMIN_BOOTSTRAP_EMAIL,
      RESEND_API_KEY: "",
      AUTH_EMAIL_FROM: "",
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
    },
  },
});
