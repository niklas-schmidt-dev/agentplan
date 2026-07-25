import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "@/proxy";

type PolicyEnvironment = NonNullable<Parameters<typeof contentSecurityPolicy>[1]>;

const baseEnvironment: PolicyEnvironment = {
  NODE_ENV: "production",
  STORAGE_DRIVER: undefined,
  BLOB_READ_WRITE_TOKEN: undefined,
  BLOB_STORE_ID: undefined,
  R2_ACCOUNT_ID: undefined,
};

function connectDirective(overrides: Partial<PolicyEnvironment> = {}): string {
  return (
    contentSecurityPolicy("test-nonce", { ...baseEnvironment, ...overrides })
      .split("; ")
      .find((directive) => directive.startsWith("connect-src ")) ?? ""
  );
}

describe("application Content Security Policy", () => {
  it("allows the Vercel Blob presigned upload endpoint when Blob is configured", () => {
    expect(connectDirective({ BLOB_STORE_ID: "store_example" })).toBe(
      "connect-src 'self' https://blob.vercel-storage.com",
    );
    expect(connectDirective({ STORAGE_DRIVER: "vercel-blob" })).toBe(
      "connect-src 'self' https://blob.vercel-storage.com",
    );
  });

  it("allows only the configured R2 account upload endpoint", () => {
    const accountId = "0123456789abcdef0123456789abcdef";
    expect(connectDirective({ STORAGE_DRIVER: "r2", R2_ACCOUNT_ID: accountId })).toBe(
      `connect-src 'self' https://${accountId}.r2.cloudflarestorage.com`,
    );
  });

  it("rejects malformed R2 account IDs instead of injecting them into the policy", () => {
    expect(
      connectDirective({
        STORAGE_DRIVER: "r2",
        R2_ACCOUNT_ID: "example; connect-src https://attacker.invalid",
      }),
    ).toBe("connect-src 'self'");
  });

  it("keeps local storage same-origin and permits the development websocket", () => {
    expect(connectDirective({ STORAGE_DRIVER: "fs" })).toBe("connect-src 'self'");
    expect(connectDirective({ STORAGE_DRIVER: "fs", NODE_ENV: "development" })).toBe(
      "connect-src 'self' ws:",
    );
  });
});
