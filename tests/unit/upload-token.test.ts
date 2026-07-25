import { afterEach, describe, expect, it, vi } from "vitest";
import { issueUploadIntentToken, verifyUploadIntentToken } from "@/lib/uploads/tokens";

describe("upload intent tokens", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("binds owner, key, provider, and expiry", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-upload-secret-with-enough-entropy");
    const expiresAt = new Date(Date.now() + 60_000);
    const token = issueUploadIntentToken({
      intentId: "intent",
      ownerId: "owner",
      stagingKey: "staging/owner/intent.png",
      provider: "r2",
      expiresAt,
    });
    expect(verifyUploadIntentToken(token)).toMatchObject({
      intentId: "intent",
      ownerId: "owner",
      stagingKey: "staging/owner/intent.png",
      provider: "r2",
    });
    expect(verifyUploadIntentToken(`${token}x`)).toBeNull();
  });
});
