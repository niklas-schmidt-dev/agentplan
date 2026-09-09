import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { applyCustomerState, clearSubscriptionForUser, syncUserFromProvider } = vi.hoisted(() => ({
  applyCustomerState: vi.fn(),
  clearSubscriptionForUser: vi.fn(),
  syncUserFromProvider: vi.fn(),
}));

vi.mock("@/lib/billing/service", () => ({
  applyCustomerState,
  clearSubscriptionForUser,
  syncUserFromProvider,
}));

import { POST } from "@/app/api/billing/webhooks/route";

const secret = "whsec-test-secret";

const customer = {
  id: "cus_1",
  type: "individual",
  created_at: "2026-09-08T00:00:00Z",
  modified_at: null,
  metadata: {},
  external_id: "user-1",
  email: "person@example.test",
  email_verified: false,
  name: null,
  billing_name: null,
  billing_address: null,
  tax_id: null,
  organization_id: "org_1",
  deleted_at: null,
  avatar_url: "https://example.test/avatar",
};

function signed(
  payload: unknown,
  options: { secret?: string; timestamp?: number; standard?: boolean } = {},
) {
  const body = JSON.stringify(payload);
  const id = "msg_1";
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const signingSecret = options.secret ?? secret;
  const key = options.standard ? Buffer.from(signingSecret.slice(6), "base64") : signingSecret;
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return new Request("http://localhost:3000/api/billing/webhooks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    },
    body,
  });
}

describe("Polar webhook route", () => {
  beforeEach(() => {
    vi.stubEnv("POLAR_ACCESS_TOKEN", "polar-token");
    vi.stubEnv("POLAR_WEBHOOK_SECRET", secret);
    vi.stubEnv("POLAR_PRO_PRODUCT_IDS", "prod_pro");
    applyCustomerState.mockReset().mockResolvedValue({ userId: "user-1", changed: true });
    clearSubscriptionForUser.mockReset().mockResolvedValue(true);
    syncUserFromProvider.mockReset().mockResolvedValue({ changed: false });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is absent when billing is not configured", async () => {
    vi.stubEnv("POLAR_WEBHOOK_SECRET", "");
    const response = await POST(signed({ type: "customer.deleted", data: customer }));
    expect(response.status).toBe(404);
    expect(clearSubscriptionForUser).not.toHaveBeenCalled();
  });

  it("rejects a bad signature without touching entitlements", async () => {
    const response = await POST(
      signed(
        { type: "customer.deleted", timestamp: "2026-09-08T00:00:00Z", data: customer },
        { secret: "wrong" },
      ),
    );
    expect(response.status).toBe(403);
    expect(clearSubscriptionForUser).not.toHaveBeenCalled();
  });

  it("rejects stale timestamps (replay protection)", async () => {
    const response = await POST(
      signed(
        { type: "customer.deleted", timestamp: "2026-09-08T00:00:00Z", data: customer },
        { timestamp: Math.floor(Date.now() / 1000) - 3600 },
      ),
    );
    expect(response.status).toBe(403);
  });

  it("accepts Standard Webhooks secrets and rejects tampering and stale delivery", async () => {
    const standardSecret = `whsec_${Buffer.from("synthetic-standard-webhook-secret").toString("base64")}`;
    vi.stubEnv("POLAR_WEBHOOK_SECRET", standardSecret);
    const payload = { type: "customer.deleted", timestamp: "2026-09-08T00:00:00Z", data: customer };
    expect((await POST(signed(payload, { secret: standardSecret, standard: true }))).status).toBe(
      200,
    );
    const tampered = signed(payload, { secret: standardSecret, standard: true });
    expect(
      (
        await POST(
          new Request(tampered.url, { method: "POST", headers: tampered.headers, body: "{}" }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await POST(
          signed(payload, {
            secret: standardSecret,
            standard: true,
            timestamp: Math.floor(Date.now() / 1000) - 3600,
          }),
        )
      ).status,
    ).toBe(403);
    expect(clearSubscriptionForUser).toHaveBeenCalledTimes(1);
  });

  it.each(["subscription.cycled", "subscription.paused", "subscription.resumed", "order.paid"])(
    "refreshes authoritative state for %s",
    async (type) => {
      const response = await POST(signed({ type, data: { customer } }));
      expect(response.status).toBe(200);
      expect(syncUserFromProvider).toHaveBeenCalledWith("user-1", expect.any(Object));
    },
  );

  it("fetches current state rather than applying a possibly stale customer snapshot", async () => {
    const response = await POST(
      signed({
        type: "customer.state_changed",
        timestamp: "2026-09-08T00:00:00Z",
        data: { ...customer, active_subscriptions: [], granted_benefits: [], active_meters: [] },
      }),
    );
    expect(response.status).toBe(200);
    expect(applyCustomerState).not.toHaveBeenCalled();
    expect(syncUserFromProvider).toHaveBeenCalledWith("user-1", expect.any(Object));
  });

  it("clears the mirror when the customer is deleted", async () => {
    const response = await POST(
      signed({ type: "customer.deleted", timestamp: "2026-09-08T00:00:00Z", data: customer }),
    );
    expect(response.status).toBe(200);
    expect(clearSubscriptionForUser).toHaveBeenCalledWith("user-1");
  });

  it("acknowledges events it does not understand", async () => {
    const response = await POST(
      signed({ type: "something.new", timestamp: "2026-09-08T00:00:00Z", data: {} }),
    );
    expect(response.status).toBe(202);
    expect(applyCustomerState).not.toHaveBeenCalled();
    expect(syncUserFromProvider).not.toHaveBeenCalled();
  });

  it("returns 500 so the provider retries when processing fails", async () => {
    clearSubscriptionForUser.mockRejectedValueOnce(new Error("database down"));
    const response = await POST(
      signed({ type: "customer.deleted", timestamp: "2026-09-08T00:00:00Z", data: customer }),
    );
    expect(response.status).toBe(500);
  });

  it("refuses oversized payloads", async () => {
    const request = new Request("http://localhost:3000/api/billing/webhooks", {
      method: "POST",
      headers: { "content-length": String(10 * 1024 * 1024) },
      body: "{}",
    });
    expect((await POST(request)).status).toBe(413);
  });
});
