import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/security/**/*.test.ts", "tests/integration/**/*.test.ts"],
    env: {
      // Never let unit tests touch a real database by accident.
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
    },
  },
});
