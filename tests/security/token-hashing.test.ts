import { describe, expect, it } from "vitest";
import { constantTimeEqual } from "@/lib/security/compare";
import { generateApiToken, hashToken, isTokenScope } from "@/lib/tokens/token";

describe("API token material", () => {
  it("never exposes the secret through the stored fields", () => {
    const generated = generateApiToken();
    expect(generated.token).toMatch(/^ap_live_[a-z0-9]{8}_[A-Za-z0-9_-]{40,}$/);
    // The stored prefix and hash must not contain the secret portion.
    const secret = generated.token.split("_").slice(3).join("_");
    expect(secret.length).toBeGreaterThanOrEqual(40);
    expect(generated.tokenPrefix).not.toContain(secret);
    expect(generated.tokenHash).not.toContain(secret);
    expect(generated.tokenHash).toHaveLength(64);
    expect(generated.tokenHash).toBe(hashToken(generated.token));
  });

  it("produces unique tokens", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateApiToken().token));
    expect(tokens.size).toBe(100);
  });

  it("hashes deterministically and diverges for different tokens", () => {
    expect(hashToken("ap_live_a")).toBe(hashToken("ap_live_a"));
    expect(hashToken("ap_live_a")).not.toBe(hashToken("ap_live_b"));
  });

  it("only recognizes known scopes", () => {
    expect(isTokenScope("drafts:read")).toBe(true);
    expect(isTokenScope("drafts:write")).toBe(true);
    expect(isTokenScope("drafts:delete")).toBe(false);
    expect(isTokenScope("admin")).toBe(false);
  });
});

describe("constantTimeEqual", () => {
  it("matches identical strings and rejects differences", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
    expect(constantTimeEqual("abc123", "abc124")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});
