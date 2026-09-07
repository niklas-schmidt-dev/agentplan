import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.QA_STAGING_URL;
if (!baseURL || !process.env.QA_STAGING_EMAIL || !process.env.QA_STAGING_PASSWORD) {
  throw new Error(
    "Staging QA requires QA_STAGING_URL, QA_STAGING_EMAIL and QA_STAGING_PASSWORD for a dedicated test account.",
  );
}
if (new URL(baseURL).protocol !== "https:") throw new Error("Staging QA requires HTTPS.");
if (process.env.QA_STAGING_CONFIRM !== baseURL)
  throw new Error(
    "Set QA_STAGING_CONFIRM to the exact dedicated staging URL to enable upload/delete QA.",
  );
export default defineConfig({
  testDir: "./tests/staging",
  workers: 1,
  forbidOnly: !!process.env.CI,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { outputFolder: ".data/qa/staging/report", open: "never" }]],
  outputDir: ".data/qa/staging/test-results",
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
