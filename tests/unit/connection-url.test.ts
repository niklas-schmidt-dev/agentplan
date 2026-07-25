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

    expect(new URL(normalized).searchParams.get("sslrootcert")).toBe("/etc/ssl/database.pem");
  });

  it("preserves connection details while making secure mode explicit", () => {
    const normalized = normalizeNodePostgresUrl(
      "postgresql://user@db.example.com/app?sslmode=require",
    );
    const url = new URL(normalized);

    expect(url.username).toBe("user");
    expect(url.password).toBe("");
    expect(url.hostname).toBe("db.example.com");
    expect(url.pathname).toBe("/app");
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
  });

  it.each(["prefer", "require", "verify-ca"])(
    "makes node-postgres secure alias %s explicit",
    (sslmode) => {
      const normalized = normalizeNodePostgresUrl(
        `postgresql://user@db.example.com/app?sslmode=${sslmode}`,
      );

      expect(new URL(normalized).searchParams.get("sslmode")).toBe("verify-full");
    },
  );

  it("preserves an explicit opt-in to libpq SSL semantics", () => {
    const normalized = normalizeNodePostgresUrl(
      "postgresql://user@db.example.com/app?uselibpqcompat=true&sslmode=require",
    );
    const url = new URL(normalized);

    expect(url.searchParams.get("uselibpqcompat")).toBe("true");
    expect(url.searchParams.get("sslmode")).toBe("require");
  });

  it.each(["disable", "no-verify", "verify-full"])("preserves explicit sslmode=%s", (sslmode) => {
    const normalized = normalizeNodePostgresUrl(
      `postgresql://user@db.example.com/app?sslmode=${sslmode}`,
    );

    expect(new URL(normalized).searchParams.get("sslmode")).toBe(sslmode);
  });

  it("normalizes Neon's require and system CA parameters together", () => {
    const normalized = normalizeNodePostgresUrl(
      "postgresql://user@db.example.com/app?sslmode=require&sslrootcert=system",
    );
    const url = new URL(normalized);

    expect(url.searchParams.get("sslmode")).toBe("verify-full");
    expect(url.searchParams.has("sslrootcert")).toBe(false);
  });
});
