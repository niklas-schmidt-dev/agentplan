import { describe, expect, it } from "vitest";
import { normalizeNodePostgresUrl } from "@/db/connection-url";

describe("normalizeNodePostgresUrl", () => {
  it("removes libpq's system CA sentinel while preserving TLS verification", () => {
    const normalized = normalizeNodePostgresUrl(
      "postgresql://user@db.example.com/app?sslmode=verify-full&sslrootcert=system&application_name=agentplan",
    );
    const url = new URL(normalized);

    expect(url.searchParams.get("sslmode")).toBe("verify-full");
    expect(url.searchParams.has("sslrootcert")).toBe(false);
    expect(url.searchParams.get("application_name")).toBe("agentplan");
  });

  it("preserves an explicit CA certificate path", () => {
    const normalized = normalizeNodePostgresUrl(
      "postgresql://user@db.example.com/app?sslmode=verify-full&sslrootcert=%2Fetc%2Fssl%2Fdatabase.pem",
    );

    expect(new URL(normalized).searchParams.get("sslrootcert")).toBe(
      "/etc/ssl/database.pem",
    );
  });

  it("leaves ordinary connection URLs unchanged in meaning", () => {
    const normalized = normalizeNodePostgresUrl(
      "postgresql://user@db.example.com/app?sslmode=require",
    );
    const url = new URL(normalized);

    expect(url.username).toBe("user");
    expect(url.password).toBe("");
    expect(url.hostname).toBe("db.example.com");
    expect(url.pathname).toBe("/app");
    expect(url.searchParams.get("sslmode")).toBe("require");
  });
});
