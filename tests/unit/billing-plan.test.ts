import { afterEach, describe, expect, it, vi } from "vitest";
import { readBillingConfig, storageBytesFromProductMetadata } from "@/lib/billing/config";
import {
  isSubscriptionCurrent,
  limitsForEffectivePlan,
  resolveEffectivePlan,
  SUBSCRIPTION_GRACE_MS,
} from "@/lib/billing/plan";
import { formatBytes, formatPrice } from "@/lib/format";
import { GiB, limitsForPlan } from "@/lib/limits/plans";

const now = new Date("2026-09-08T12:00:00Z");
const inFuture = new Date(now.getTime() + 20 * 24 * 3600 * 1000);
const inPast = new Date(now.getTime() - 20 * 24 * 3600 * 1000);

function subscription(
  overrides: Partial<Parameters<typeof isSubscriptionCurrent>[0] & object> = {},
) {
  return {
    status: "active",
    storageBytes: 10 * GiB,
    currentPeriodEnd: inFuture,
    endsAt: null,
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

describe("billing plan resolution", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("treats active and trialing subscriptions inside their period as current", () => {
    expect(isSubscriptionCurrent(subscription(), now)).toBe(true);
    expect(isSubscriptionCurrent(subscription({ status: "trialing" }), now)).toBe(true);
    expect(isSubscriptionCurrent(subscription({ status: "canceled" }), now)).toBe(false);
    expect(isSubscriptionCurrent(subscription({ status: "past_due" }), now)).toBe(false);
    expect(isSubscriptionCurrent(null, now)).toBe(false);
  });

  it("keeps a lapsed period only within the grace window", () => {
    const justLapsed = new Date(now.getTime() - SUBSCRIPTION_GRACE_MS + 60_000);
    const longLapsed = new Date(now.getTime() - SUBSCRIPTION_GRACE_MS - 60_000);
    expect(isSubscriptionCurrent(subscription({ currentPeriodEnd: justLapsed }), now)).toBe(true);
    expect(isSubscriptionCurrent(subscription({ currentPeriodEnd: longLapsed }), now)).toBe(false);
    expect(isSubscriptionCurrent(subscription({ endsAt: inPast }), now)).toBe(false);
  });

  it("a cancelled-at-period-end subscription stays current until the period ends", () => {
    expect(
      isSubscriptionCurrent(subscription({ cancelAtPeriodEnd: true, endsAt: inFuture }), now),
    ).toBe(true);
  });

  it("free users become pro through a current subscription and fall back when it lapses", () => {
    expect(resolveEffectivePlan("free", subscription(), now)).toEqual({
      plan: "pro",
      storageBytes: 10 * GiB,
      source: "subscription",
    });
    expect(resolveEffectivePlan("free", subscription({ status: "canceled" }), now)).toEqual({
      plan: "free",
      storageBytes: limitsForPlan("free").maxStorageBytes,
      source: "granted",
    });
    expect(resolveEffectivePlan("free", null, now).plan).toBe("free");
  });

  it("billing never lowers an operator-granted plan", () => {
    expect(resolveEffectivePlan("unlimited", subscription({ status: "canceled" }), now)).toEqual({
      plan: "unlimited",
      storageBytes: null,
      source: "granted",
    });
    vi.stubEnv("AP_PRO_STORAGE_BYTES", String(20 * GiB));
    expect(resolveEffectivePlan("pro", subscription({ storageBytes: 5 * GiB }), now)).toEqual({
      plan: "pro",
      storageBytes: 20 * GiB,
      source: "granted",
    });
    expect(resolveEffectivePlan("pro", subscription({ storageBytes: 50 * GiB }), now)).toEqual({
      plan: "pro",
      storageBytes: 50 * GiB,
      source: "subscription",
    });
    expect(resolveEffectivePlan("pro", null, now).storageBytes).toBe(20 * GiB);
  });

  it("pro limits are storage-bound only", () => {
    const limits = limitsForEffectivePlan({
      plan: "pro",
      storageBytes: 7 * GiB,
      source: "subscription",
    });
    expect(limits).toEqual({
      maxDrafts: null,
      keepVersionsByKind: { html: null, image: null, video: null },
      maxStorageBytes: 7 * GiB,
      maxActiveTokens: null,
      uploadsPerTenMinutes: 120,
      uploadsPerDay: 2_000,
    });
    expect(limitsForPlan("pro").maxStorageBytes).toBe(10 * GiB);
    expect(limitsForPlan("unlimited").maxStorageBytes).toBeNull();
  });
});

describe("billing configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is disabled unless token, webhook secret, and products are all present", () => {
    expect(readBillingConfig({})).toBeNull();
    expect(readBillingConfig({ POLAR_ACCESS_TOKEN: "t", POLAR_WEBHOOK_SECRET: "s" })).toBeNull();
    expect(
      readBillingConfig({
        POLAR_ACCESS_TOKEN: "t",
        POLAR_WEBHOOK_SECRET: "s",
        POLAR_PRO_PRODUCT_IDS: " prod_a, prod_b ,prod_a,",
        POLAR_SERVER: "Sandbox",
      }),
    ).toEqual({
      accessToken: "t",
      webhookSecret: "s",
      productIds: ["prod_a", "prod_b"],
      server: "sandbox",
    });
    expect(
      readBillingConfig({
        POLAR_ACCESS_TOKEN: "t",
        POLAR_WEBHOOK_SECRET: "s",
        POLAR_PRO_PRODUCT_IDS: "prod_a",
      })?.server,
    ).toBe("production");
  });

  it("reads a storage tier from product metadata", () => {
    expect(storageBytesFromProductMetadata({ storage_gb: 25 })).toBe(25 * GiB);
    expect(storageBytesFromProductMetadata({ storage_gb: "2.5" })).toBe(2.5 * GiB);
    expect(storageBytesFromProductMetadata({ storageGb: 1 })).toBe(GiB);
    expect(storageBytesFromProductMetadata({ storage_gb: "lots" })).toBeNull();
    expect(storageBytesFromProductMetadata({ storage_gb: 0 })).toBeNull();
    expect(storageBytesFromProductMetadata(null)).toBeNull();
  });
});

describe("billing formatting", () => {
  it("formats gigabytes and prices", () => {
    expect(formatBytes(10 * GiB)).toBe("10 GB");
    expect(formatBytes(2.5 * GiB)).toBe("2.5 GB");
    expect(formatBytes(50 * 1024 * 1024)).toBe("50 MB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024 * 1.25)).toBe("1.25 MB");
    expect(formatPrice(300, "eur")).toBe("€3");
    expect(formatPrice(250, "usd")).toBe("$2.50");
  });
});
