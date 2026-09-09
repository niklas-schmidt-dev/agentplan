import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must be configured before the lazy storage/db singletons are first used.
process.env.STORAGE_DRIVER = "fs";
process.env.STORAGE_FS_ROOT = mkdtempSync(path.join(os.tmpdir(), "agentplan-billing-"));

import { and, eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { auditEvents, billingSubscriptions, users, type UserPlan } from "@/db/schema";
import { setUserPlan } from "@/lib/admin/service";
import type { BillingConfig } from "@/lib/billing/config";
import {
  applyCustomerState,
  applySubscriptions,
  clearProductCache,
  getEffectivePlanForUser,
  type SubscriptionInput,
} from "@/lib/billing/service";
import { addVersionToDraft, createDraftWithFirstVersion } from "@/lib/drafts/service";
import { getUserLimits } from "@/lib/limits/enforce";
import { QuotaExceededError } from "@/lib/limits/errors";
import { GiB } from "@/lib/limits/plans";
import { createToken } from "@/lib/tokens/service";

const hasDb = Boolean(process.env.DATABASE_URL);
const html = new TextEncoder().encode("<!doctype html><h1>billing</h1>");
const config: BillingConfig = {
  accessToken: "test",
  webhookSecret: "test",
  server: "sandbox",
  productIds: ["prod_pro", "prod_pro_big"],
};
const createdUserIds: string[] = [];

async function createUser(plan: UserPlan = "free"): Promise<string> {
  const id = `billing-user-${randomUUID()}`;
  await getDb()
    .insert(users)
    .values({
      id,
      name: "Billing User",
      email: `${id}@example.test`,
      emailVerified: true,
      role: "admin",
      plan,
    });
  createdUserIds.push(id);
  return id;
}

function input(overrides: Partial<SubscriptionInput> = {}): SubscriptionInput {
  return {
    subscriptionId: `sub_${randomUUID()}`,
    customerId: "cus_1",
    productId: "prod_pro",
    productName: "Pro",
    status: "active",
    amount: 300,
    currency: "eur",
    recurringInterval: "month",
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    cancelAtPeriodEnd: false,
    endsAt: null,
    storageBytes: 10 * GiB,
    ...overrides,
  };
}

describe.skipIf(!hasDb)("billing subscriptions (integration)", () => {
  beforeEach(() => clearProductCache());
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    if (createdUserIds.length) {
      await getDb().delete(users).where(inArray(users.id, createdUserIds));
    }
    await closeDb();
  });

  it("mirrors an active subscription and lifts the free caps", async () => {
    vi.stubEnv("AP_MAX_DRAFTS_PER_USER", "1");
    vi.stubEnv("AP_MAX_ACTIVE_TOKENS_PER_USER", "1");
    const userId = await createUser();
    expect((await getEffectivePlanForUser(userId)).plan).toBe("free");

    const active = input();
    const result = await applySubscriptions(userId, [active], { config });
    expect(result.changed).toBe(true);
    expect(result.plan).toEqual({ plan: "pro", storageBytes: 10 * GiB, source: "subscription" });

    const limits = await getUserLimits(userId);
    expect(limits.maxDrafts).toBeNull();
    expect(limits.maxActiveTokens).toBeNull();
    expect(limits.maxStorageBytes).toBe(10 * GiB);

    // Two drafts and two tokens would exceed the stubbed free caps.
    await createDraftWithFirstVersion({
      ownerId: userId,
      title: "One",
      visibility: "private",
      bytes: html,
      source: "browser",
    });
    await createDraftWithFirstVersion({
      ownerId: userId,
      title: "Two",
      visibility: "private",
      bytes: html,
      source: "browser",
    });
    await createToken({ userId, name: "a", scopes: ["drafts:read"] });
    await createToken({ userId, name: "b", scopes: ["drafts:read"] });

    const [event] = await getDb()
      .select({ metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "billing.subscription_changed"),
          eq(auditEvents.userId, userId),
        ),
      );
    expect(event?.metadata).toMatchObject({ effectivePlan: "pro", status: "active" });

    // Re-applying identical state is a no-op.
    const again = await applySubscriptions(userId, [active], { config });
    expect(again.changed).toBe(false);
  });

  it("enforces the paid storage tier and drops back to free caps after cancellation", async () => {
    vi.stubEnv("AP_MAX_DRAFTS_PER_USER", "1");
    const userId = await createUser();
    await applySubscriptions(userId, [input({ storageBytes: 40 })], { config });
    const { draft } = await createDraftWithFirstVersion({
      ownerId: userId,
      title: "Small",
      visibility: "private",
      bytes: html,
      source: "browser",
    });
    await expect(
      addVersionToDraft({ draft, bytes: html, source: "browser" }),
    ).rejects.toBeInstanceOf(QuotaExceededError);

    // Provider reports no active subscription: mirror row goes away, free caps return.
    const cleared = await applySubscriptions(userId, [], { config });
    expect(cleared.changed).toBe(true);
    expect(cleared.plan.plan).toBe("free");
    expect(await row(userId)).toBeUndefined();
    await expect(
      createDraftWithFirstVersion({
        ownerId: userId,
        title: "Second",
        visibility: "private",
        bytes: html,
        source: "browser",
      }),
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("ignores foreign products and inactive statuses, prefers the largest tier", async () => {
    const userId = await createUser();
    const result = await applySubscriptions(
      userId,
      [
        input({ productId: "prod_other", storageBytes: 999 * GiB }),
        input({ status: "canceled", storageBytes: 500 * GiB }),
        input({ productId: "prod_pro", storageBytes: 10 * GiB }),
        input({ productId: "prod_pro_big", storageBytes: 50 * GiB, productName: "Pro 50" }),
      ],
      { config },
    );
    expect(result.plan.storageBytes).toBe(50 * GiB);
    expect((await row(userId))?.productName).toBe("Pro 50");
  });

  it("resolves storage from product metadata when the payload lacks it", async () => {
    const userId = await createUser();
    const storageForProduct = vi.fn(async () => 25 * GiB);
    const result = await applySubscriptions(userId, [input({ storageBytes: null })], {
      config,
      storageForProduct,
    });
    expect(storageForProduct).toHaveBeenCalledWith("prod_pro");
    expect(result.plan.storageBytes).toBe(25 * GiB);

    const fallback = await applySubscriptions(
      userId,
      [input({ storageBytes: null, subscriptionId: "sub_fallback" })],
      { config, storageForProduct: async () => null },
    );
    expect(fallback.plan.storageBytes).toBe(10 * GiB);
  });

  it("never lowers an operator-granted plan", async () => {
    const unlimitedId = await createUser("unlimited");
    await applySubscriptions(unlimitedId, [], { config });
    expect(await getEffectivePlanForUser(unlimitedId)).toEqual({
      plan: "unlimited",
      storageBytes: null,
      source: "granted",
    });

    const proId = await createUser("pro");
    await applySubscriptions(proId, [input({ storageBytes: GiB })], { config });
    expect((await getEffectivePlanForUser(proId)).storageBytes).toBe(10 * GiB);
    await applySubscriptions(proId, [], { config });
    expect((await getEffectivePlanForUser(proId)).plan).toBe("pro");
  });

  it("applies a customer state payload keyed by external id", async () => {
    const userId = await createUser();
    const applied = await applyCustomerState(
      {
        id: "cus_state",
        createdAt: new Date(),
        modifiedAt: null,
        metadata: {},
        externalId: userId,
        email: "person@example.test",
        emailVerified: false,
        name: null,
        billingName: null,
        billingAddress: null,
        taxId: null,
        organizationId: "org_1",
        deletedAt: null,
        avatarUrl: "https://example.test/avatar",
        activeSubscriptions: [
          {
            id: "sub_state",
            createdAt: new Date(),
            modifiedAt: null,
            customFieldData: {},
            metadata: {},
            status: "active",
            amount: 300,
            currency: "eur",
            recurringInterval: "month",
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(Date.now() + 86_400_000),
            trialStart: null,
            trialEnd: null,
            cancelAtPeriodEnd: false,
            canceledAt: null,
            startedAt: new Date(),
            endsAt: null,
            productId: "prod_pro",
            discountId: null,
            checkoutId: null,
            priceId: "price_1",
            meters: [],
          },
        ],
        grantedBenefits: [],
        activeMeters: [],
      } as unknown as Parameters<typeof applyCustomerState>[0],
      { config, storageForProduct: async () => 10 * GiB, productNameForProduct: async () => "Pro" },
    );
    expect(applied).toEqual({ userId, changed: true });
    expect((await row(userId))?.customerId).toBe("cus_state");

    const unknown = await applyCustomerState(
      { externalId: null, activeSubscriptions: [] } as unknown as Parameters<
        typeof applyCustomerState
      >[0],
      { config },
    );
    expect(unknown).toBeNull();
  });

  it("admins can grant pro directly", async () => {
    const actorId = await createUser();
    const targetId = await createUser();
    // The signup trigger only lets the first row become admin; promote explicitly.
    await getDb().update(users).set({ role: "admin" }).where(eq(users.id, actorId));
    await setUserPlan({ userId: actorId }, targetId, "pro");
    expect((await getEffectivePlanForUser(targetId)).plan).toBe("pro");
    expect((await getUserLimits(targetId)).maxDrafts).toBeNull();
  });

  it("ignores users that no longer exist", async () => {
    const result = await applySubscriptions(`missing-${randomUUID()}`, [input()], { config });
    expect(result.changed).toBe(false);
    expect(result.plan.plan).toBe("free");
  });
});

async function row(userId: string) {
  const [found] = await getDb()
    .select()
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.userId, userId))
    .limit(1);
  return found;
}
