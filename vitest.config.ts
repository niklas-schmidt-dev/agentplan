import path from "node:path";
import { defineConfig } from "vitest/config";

if (process.env.REQUIRE_DATABASE_TESTS === "1" && !process.env.TEST_DATABASE_URL) {
  throw new Error("Full verification requires TEST_DATABASE_URL. Run npm run check:full.");
}

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/unit/**/*.test.ts",
      "tests/security/**/*.test.ts",
      "tests/integration/**/*.test.ts",
    ],
    // Integration files share one database and some (admin, signup-hook)
    // toggle global settings like signups_enabled; parallel files would race.
    fileParallelism: false,
    env: {
      // Never let unit tests touch a real database by accident.
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
      // Version history is a Pro feature; the Free default keeps one version
      // per draft. Suites exercise history on Free fixtures with raised caps.
      // limits.test and billing-plan.test cover the real default explicitly.
      AP_MAX_VERSIONS_PER_DRAFT: "100",
      AP_MAX_IMAGE_VERSIONS_PER_DRAFT: "20",
      AP_MAX_VIDEO_VERSIONS_PER_DRAFT: "2",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
    },
  },
});
