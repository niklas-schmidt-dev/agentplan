import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        // E2E needs the test-only auth/seed paths enabled and a database.
        command: "npm run dev",
        url: "http://localhost:3000/healthz",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          E2E_AUTH: "1",
          STORAGE_DRIVER: "fs",
          STORAGE_FS_ROOT: process.env.STORAGE_FS_ROOT ?? ".data/e2e-storage",
          DATABASE_URL: process.env.DATABASE_URL ?? "",
          BETTER_AUTH_SECRET:
            process.env.BETTER_AUTH_SECRET ?? "e2e-secret-not-for-production-0000",
          BETTER_AUTH_URL: "http://localhost:3000",
          NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        },
      },
});
