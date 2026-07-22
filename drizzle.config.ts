import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Direct (non-pooled) connection — DDL must never go through PgBouncer.
    url: process.env.DATABASE_URL_DIRECT ?? "",
  },
});
