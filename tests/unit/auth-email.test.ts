import { afterEach, describe, expect, it, vi } from "vitest";
import { isEmailDeliveryConfigured, sendAuthEmail } from "@/lib/auth/email";

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

  it("reports unavailable delivery and fails closed when no provider is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("AUTH_EMAIL_FROM", "");
    vi.stubEnv("AUTH_EMAIL_WEBHOOK_URL", "");
    vi.stubEnv("AUTH_EMAIL_WEBHOOK_SECRET", "");

    expect(isEmailDeliveryConfigured()).toBe(false);
    await expect(sendAuthEmail(message)).rejects.toThrow(/not configured/);
  });

  it("reports production delivery only for a complete delivery option", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "test-resend-key");
    vi.stubEnv("AUTH_EMAIL_FROM", "");
    expect(isEmailDeliveryConfigured()).toBe(false);

    vi.stubEnv("AUTH_EMAIL_FROM", "AgentPlan <auth@agentplan.app>");
    expect(isEmailDeliveryConfigured()).toBe(true);
  });

  it("sends verification and reset links through Resend when configured", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-resend-key");
    vi.stubEnv("AUTH_EMAIL_FROM", "AgentPlan <auth@agentplan.app>");
    vi.stubEnv("AUTH_EMAIL_WEBHOOK_URL", "https://unused.example.test/send");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ id: "email-id" }, { status: 200, headers: { "x-test": "ok" } }),
      );

    await sendAuthEmail(message);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [endpoint, init] = fetchSpy.mock.calls[0]!;
    expect(String(endpoint)).toBe("https://api.resend.com/emails");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-resend-key");
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    expect(body.from).toBe("AgentPlan <auth@agentplan.app>");
    expect(body.to).toBe(message.to);
    expect(body.subject).toBe("Verify your AgentPlan email");
    expect(body.text).toContain(message.url);
    expect(body.html).toContain(message.url);
  });

  it("uses a complete webhook when the Resend configuration is incomplete", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "test-resend-key");
    vi.stubEnv("AUTH_EMAIL_FROM", "");
    vi.stubEnv("AUTH_EMAIL_WEBHOOK_URL", "https://mailer.example.test/send");
    vi.stubEnv("AUTH_EMAIL_WEBHOOK_SECRET", "delivery-secret");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));

    expect(isEmailDeliveryConfigured()).toBe(true);
    await sendAuthEmail(message);

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://mailer.example.test/send");
  });

  it("rejects cleartext non-local delivery endpoints", async () => {
    vi.stubEnv("AUTH_EMAIL_WEBHOOK_URL", "http://mailer.example.test/send");
    await expect(sendAuthEmail(message)).rejects.toThrow(/must use HTTPS/);
  });

  it("posts tokens only to the configured HTTPS webhook with redirect following disabled", async () => {
    vi.stubEnv("AUTH_EMAIL_WEBHOOK_URL", "https://mailer.example.test/send");
    vi.stubEnv("AUTH_EMAIL_WEBHOOK_SECRET", "delivery-secret");
    vi.stubEnv("AUTH_EMAIL_FROM", "security@agentplan.app");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));

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
