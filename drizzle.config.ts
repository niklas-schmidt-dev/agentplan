import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const migrationUrl =
  [
    process.env.DATABASE_URL_DIRECT,
    process.env.DATABASE_URL_UNPOOLED,
    process.env.DATABASE_URL,
  ].find((value) => value?.trim()) ?? "";

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Prefer a direct connection for DDL. Neon names its automatically
    // provisioned direct URL DATABASE_URL_UNPOOLED.
    url: migrationUrl,
  },
});
