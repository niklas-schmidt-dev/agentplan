import { afterEach, describe, expect, it, vi } from "vitest";
import { sendAuthEmail } from "@/lib/auth/email";

const message = {
  kind: "verify_email" as const,
  to: "person@example.test",
  name: "Person",
  url: "https://agentplan.app/api/auth/verify-email?token=private",
};

describe("auth email delivery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("fails closed when production delivery is not configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_EMAIL_WEBHOOK_URL", "");
    await expect(sendAuthEmail(message)).rejects.toThrow(/required in production/);
  });

  it("rejects cleartext non-local delivery endpoints", async () => {
    vi.stubEnv("AUTH_EMAIL_WEBHOOK_URL", "http://mailer.example.test/send");
    await expect(sendAuthEmail(message)).rejects.toThrow(/must use HTTPS/);
  });

  it("posts tokens only to the configured HTTPS webhook with redirect following disabled", async () => {
    vi.stubEnv("AUTH_EMAIL_WEBHOOK_URL", "https://mailer.example.test/send");
    vi.stubEnv("AUTH_EMAIL_WEBHOOK_SECRET", "delivery-secret");
    vi.stubEnv("AUTH_EMAIL_FROM", "security@agentplan.app");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));

    await sendAuthEmail(message);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [endpoint, init] = fetchSpy.mock.calls[0]!;
    expect(String(endpoint)).toBe("https://mailer.example.test/send");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer delivery-secret");
    expect(JSON.parse(String(init?.body))).toEqual({
      ...message,
      from: "security@agentplan.app",
    });
  });
});
