import { afterEach, describe, expect, it, vi } from "vitest";
import { checkoutIdentity, localEnvironment } from "../../scripts/qa-environment.mjs";
import { startInbox } from "../../scripts/qa-mail.mjs";

afterEach(() => vi.unstubAllEnvs());

describe("isolated QA environment", () => {
  it("overrides deployment configuration without exposing it to the local app", () => {
    vi.stubEnv("DATABASE_URL", "postgres://sensitive-host/production");
    vi.stubEnv("RESEND_API_KEY", "production-email-key");
    vi.stubEnv("AUTH_EMAIL_WEBHOOK_URL", "https://production-email.example");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "production-storage-key");
    vi.stubEnv("AP_MAX_STORAGE_BYTES_PER_USER", "10");
    vi.stubEnv("PLAYWRIGHT_BASE_URL", "https://production.example");
    const env = localEnvironment({
      id: "test",
      databaseUrl: "postgres://localhost/qa",
      authSecret: "local-auth",
      url: "http://localhost:1234",
      mailUrl: "http://127.0.0.1:1235",
      mailSecret: "local-mail",
    });
    expect(env.DATABASE_URL).toBe("postgres://localhost/qa");
    expect(env.DATABASE_URL_DIRECT).toBe(env.DATABASE_URL);
    expect(env.TEST_DATABASE_URL).toBe(env.DATABASE_URL);
    expect(env.STORAGE_DRIVER).toBe("fs");
    expect(env.RESEND_API_KEY).toBe("");
    expect(env.BLOB_READ_WRITE_TOKEN).toBe("");
    expect(env.AUTH_EMAIL_WEBHOOK_URL).toBe("http://127.0.0.1:1235");
    expect(env.AP_MAX_STORAGE_BYTES_PER_USER).toBe("");
    expect(env.PLAYWRIGHT_BASE_URL).toBeUndefined();
    expect(checkoutIdentity("/tmp/a")).not.toBe(checkoutIdentity("/tmp/b"));
    expect(checkoutIdentity("/tmp/a")).toBe(checkoutIdentity("/tmp/a"));
  });

  it("captures only authenticated email deliveries and filters by recipient", async () => {
    const server = await startInbox(0, "local-secret");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP inbox");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const message = {
        kind: "verify_email",
        to: "one@example.test",
        url: "http://localhost/verify?token=test",
      };
      expect((await fetch(url, { method: "POST", body: JSON.stringify(message) })).status).toBe(
        403,
      );
      expect(
        (
          await fetch(url, {
            method: "POST",
            headers: { authorization: "Bearer local-secret" },
            body: JSON.stringify(message),
          })
        ).status,
      ).toBe(200);
      expect(await (await fetch(`${url}/messages?to=one@example.test`)).json()).toEqual([message]);
      expect(await (await fetch(`${url}/messages?to=two@example.test`)).json()).toEqual([]);
      expect(
        (await fetch(`${url}/messages?to=one@example.test`)).headers.get("cache-control"),
      ).toBe("no-store");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
