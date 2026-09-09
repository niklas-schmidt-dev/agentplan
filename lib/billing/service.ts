import type { CustomerState } from "@polar-sh/sdk/models/components/customerstate.js";
import type { Subscription } from "@polar-sh/sdk/models/components/subscription.js";
import { ResourceNotFound } from "@polar-sh/sdk/models/errors/resourcenotfound.js";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { billingSubscriptions, users } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit/events";
import { appUrl } from "@/lib/urls";
import {
  getPolarClient,
  readBillingConfig,
  storageBytesFromProductMetadata,
  type BillingConfig,
} from "./config";
import { resolveEffectivePlan, type EffectivePlan } from "./plan";
import { defaultProStorageBytes } from "@/lib/limits/plans";
import { billingErrorSummary } from "./errors";

/** Provider-agnostic view of one paid subscription. */
export type SubscriptionInput = {
  subscriptionId: string;
  customerId: string;
  productId: string;
  productName: string | null;
  status: string;
  amount: number;
  currency: string;
  recurringInterval: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  endsAt: Date | null;
  /** Known when the provider embedded the product; otherwise resolved lazily. */
  storageBytes: number | null;
};

export type StorageResolver = (productId: string) => Promise<number | null>;

type Product = { name: string; storageBytes: number | null };
const productCache = new Map<string, { value: Product; expiresAt: number }>();
const PRODUCT_CACHE_MS = 10 * 60 * 1000;

/** Product lookups are cached per instance; metadata rarely changes. */
export async function resolveProduct(
  productId: string,
  config: BillingConfig | null = readBillingConfig(),
): Promise<Product | null> {
  const cached = productCache.get(productId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (!config) return null;
  try {
    const product = await getPolarClient(config).products.get({ id: productId });
    const value = {
      name: product.name,
      storageBytes: storageBytesFromProductMetadata(product.metadata),
    };
    productCache.set(productId, { value, expiresAt: Date.now() + PRODUCT_CACHE_MS });
    return value;
  } catch (error) {
    console.error("Polar product lookup failed", productId, billingErrorSummary(error));
    return null;
  }
}

/** Test hook: forget cached products. */
export function clearProductCache(): void {
  productCache.clear();
}

export function subscriptionInputFromState(
  subscription: CustomerState["activeSubscriptions"][number],
  customerId: string,
): SubscriptionInput {
  return {
    subscriptionId: subscription.id,
    customerId,
    productId: subscription.productId,
    productName: null,
    status: subscription.status,
    amount: subscription.amount,
    currency: subscription.currency,
    recurringInterval: subscription.recurringInterval,
    currentPeriodEnd: subscription.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    endsAt: subscription.endsAt ?? null,
    storageBytes: null,
  };
}

export function subscriptionInputFromSubscription(subscription: Subscription): SubscriptionInput {
  return {
    subscriptionId: subscription.id,
    customerId: subscription.customerId,
    productId: subscription.productId,
    productName: subscription.product.name,
    status: subscription.status,
    amount: subscription.amount,
    currency: subscription.currency,
    recurringInterval: subscription.recurringInterval,
    currentPeriodEnd: subscription.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    endsAt: subscription.endsAt ?? null,
    storageBytes: storageBytesFromProductMetadata(subscription.product.metadata),
  };
}

const CURRENT_STATUSES = new Set(["active", "trialing"]);

/**
 * Mirrors the provider's view of one user into billing_subscriptions. Only
 * subscriptions for configured Pro products count; among several current ones
 * the most generous storage wins. Returns whether the stored row changed.
 */
export async function applySubscriptions(
  userId: string,
  inputs: SubscriptionInput[],
  options: {
    config?: BillingConfig | null;
    storageForProduct?: StorageResolver;
    productNameForProduct?: (productId: string) => Promise<string | null>;
  } = {},
): Promise<{ changed: boolean; plan: EffectivePlan }> {
  const config = options.config === undefined ? readBillingConfig() : options.config;
  const allowedProducts = new Set(config?.productIds ?? []);
  const candidates = inputs.filter(
    (input) => allowedProducts.has(input.productId) && CURRENT_STATUSES.has(input.status),
  );

  const resolved = await Promise.all(
    candidates.map(async (input) => {
      let storageBytes = input.storageBytes;
      let productName = input.productName;
      if (storageBytes === null || productName === null) {
        const product = options.storageForProduct
          ? {
              storageBytes: await options.storageForProduct(input.productId),
              name: (await options.productNameForProduct?.(input.productId)) ?? null,
            }
          : await resolveProduct(input.productId, config);
        storageBytes ??= product?.storageBytes ?? null;
        productName ??= product?.name ?? null;
      }
      return {
        ...input,
        storageBytes: storageBytes ?? defaultProStorageBytes(),
        productName: productName ?? "Pro",
      };
    }),
  );
  resolved.sort((a, b) => b.storageBytes - a.storageBytes);
  const winner = resolved[0] ?? null;

  const result = await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('agentplan:billing'), hashtext(${userId}))`,
    );
    const [user] = await tx
      .select({ plan: users.plan })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return null;
    const [existing] = await tx
      .select()
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.userId, userId))
      .limit(1);

    if (!winner) {
      if (existing) {
        await tx.delete(billingSubscriptions).where(eq(billingSubscriptions.userId, userId));
      } else {
        await tx
          .update(billingSubscriptions)
          .set({ syncedAt: sql`now()` })
          .where(eq(billingSubscriptions.userId, userId));
      }
      return { changed: Boolean(existing), grantedPlan: user.plan, row: null, previous: existing };
    }

    const values = {
      userId,
      provider: "polar",
      customerId: winner.customerId,
      subscriptionId: winner.subscriptionId,
      productId: winner.productId,
      productName: winner.productName,
      status: winner.status,
      storageBytes: winner.storageBytes,
      amount: winner.amount,
      currency: winner.currency,
      recurringInterval: winner.recurringInterval,
      currentPeriodEnd: winner.currentPeriodEnd,
      cancelAtPeriodEnd: winner.cancelAtPeriodEnd,
      endsAt: winner.endsAt,
      syncedAt: sql`now()`,
    };
    const [row] = await tx
      .insert(billingSubscriptions)
      .values(values)
      .onConflictDoUpdate({ target: billingSubscriptions.userId, set: values })
      .returning();
    const changed =
      !existing ||
      existing.subscriptionId !== winner.subscriptionId ||
      existing.productId !== winner.productId ||
      existing.status !== winner.status ||
      existing.storageBytes !== winner.storageBytes ||
      existing.cancelAtPeriodEnd !== winner.cancelAtPeriodEnd ||
      existing.currentPeriodEnd?.getTime() !== winner.currentPeriodEnd?.getTime() ||
      existing.endsAt?.getTime() !== winner.endsAt?.getTime();
    return { changed, grantedPlan: user.plan, row: row ?? null, previous: existing };
  });

  if (!result) {
    return { changed: false, plan: resolveEffectivePlan("free", null) };
  }
  const plan = resolveEffectivePlan(result.grantedPlan, result.row);
  if (result.changed) {
    await recordAuditEvent({
      type: "billing.subscription_changed",
      userId,
      metadata: {
        provider: "polar",
        subscriptionId: result.row?.subscriptionId ?? result.previous?.subscriptionId ?? null,
        productId: result.row?.productId ?? null,
        status: result.row?.status ?? "none",
        storageBytes: result.row?.storageBytes ?? null,
        effectivePlan: plan.plan,
      },
    });
  }
  return { changed: result.changed, plan };
}

/** Applies a `customer.state_changed` payload (or a fetched customer state). */
export async function applyCustomerState(
  state: CustomerState,
  options: Parameters<typeof applySubscriptions>[2] = {},
): Promise<{ userId: string; changed: boolean } | null> {
  const userId = state.externalId?.trim();
  if (!userId) return null;
  const inputs = state.activeSubscriptions.map((subscription) =>
    subscriptionInputFromState(subscription, state.id),
  );
  const { changed } = await applySubscriptions(userId, inputs, options);
  return { userId, changed };
}

/** Pulls the authoritative customer state from Polar for one user. */
export async function syncUserFromProvider(
  userId: string,
  config: BillingConfig | null = readBillingConfig(),
): Promise<{ changed: boolean } | null> {
  if (!config) return null;
  try {
    const state = await getPolarClient(config).customers.getStateExternal({ externalId: userId });
    const applied = await applyCustomerState(state, { config });
    return applied ? { changed: applied.changed } : { changed: false };
  } catch (error) {
    if (error instanceof ResourceNotFound) {
      const { changed } = await applySubscriptions(userId, [], { config });
      return { changed };
    }
    throw error;
  }
}

/** Removes the local mirror when the provider deleted the customer. */
export async function clearSubscriptionForUser(userId: string): Promise<boolean> {
  const { changed } = await applySubscriptions(userId, [], { config: null });
  return changed;
}

export async function getSubscriptionForUser(
  userId: string,
  db: Pick<Database, "select"> = getDb(),
) {
  const [row] = await db
    .select()
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.userId, userId))
    .limit(1);
  return row ?? null;
}

/** Granted plan + mirrored subscription → the plan quota checks should use. */
export async function getEffectivePlanForUser(
  userId: string,
  db: Pick<Database, "select"> = getDb(),
): Promise<EffectivePlan> {
  const [row] = await db
    .select({ plan: users.plan, subscription: billingSubscriptions })
    .from(users)
    .leftJoin(billingSubscriptions, eq(billingSubscriptions.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  return resolveEffectivePlan(row?.plan ?? "free", row?.subscription ?? null);
}

export async function getEffectivePlansForUsers(
  userIds: string[],
  db: Pick<Database, "select"> = getDb(),
): Promise<
  Map<string, EffectivePlan & { subscription: typeof billingSubscriptions.$inferSelect | null }>
> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, plan: users.plan, subscription: billingSubscriptions })
    .from(users)
    .leftJoin(billingSubscriptions, eq(billingSubscriptions.userId, users.id))
    .where(inArray(users.id, userIds));
  return new Map(
    rows.map((row) => [
      row.id,
      { ...resolveEffectivePlan(row.plan, row.subscription), subscription: row.subscription },
    ]),
  );
}

export type ProPlanOffer = {
  productId: string;
  name: string;
  description: string | null;
  storageBytes: number;
  /** Minor units (cents); null for non-fixed pricing. */
  amount: number | null;
  currency: string | null;
  recurringInterval: string | null;
};

let offerCache: { key: string; value: ProPlanOffer[]; expiresAt: number } | undefined;

/**
 * Configured Pro products with their display price and storage, for the
 * billing page. Provider failures degrade to an empty list so the dashboard
 * still renders; the checkout button is then hidden.
 */
export async function listProPlanOffers(
  config: BillingConfig | null = readBillingConfig(),
): Promise<ProPlanOffer[]> {
  if (!config) return [];
  const key = config.productIds.join(",");
  if (offerCache?.key === key && offerCache.expiresAt > Date.now()) return offerCache.value;
  const offers: ProPlanOffer[] = [];
  for (const productId of config.productIds) {
    try {
      const product = await getPolarClient(config).products.get({ id: productId });
      if (product.isArchived) continue;
      const price = product.prices.find(
        (candidate) => !candidate.isArchived && candidate.amountType === "fixed",
      );
      offers.push({
        productId,
        name: product.name,
        description: product.description,
        storageBytes: storageBytesFromProductMetadata(product.metadata) ?? defaultProStorageBytes(),
        amount: price && "priceAmount" in price ? price.priceAmount : null,
        currency: price && "priceCurrency" in price ? price.priceCurrency : null,
        recurringInterval: product.recurringInterval,
      });
    } catch (error) {
      console.error("Polar product lookup failed", productId, billingErrorSummary(error));
    }
  }
  offerCache = { key, value: offers, expiresAt: Date.now() + PRODUCT_CACHE_MS };
  return offers;
}

export type CheckoutTarget = { userId: string; email: string; name: string };

/**
 * Hosted checkout for the configured Pro products. The Better Auth user id is
 * the customer's external id, so webhooks map straight back to the account.
 */
export async function createCheckoutUrl(
  target: CheckoutTarget,
  productId?: string,
  config: BillingConfig | null = readBillingConfig(),
): Promise<string> {
  if (!config) throw new Error("Billing is not configured");
  const products =
    productId && config.productIds.includes(productId)
      ? [productId, ...config.productIds.filter((id) => id !== productId)]
      : config.productIds;
  const base = appUrl();
  const checkout = await getPolarClient(config).checkouts.create({
    products,
    externalCustomerId: target.userId,
    customerEmail: target.email,
    customerName: target.name || null,
    successUrl: `${base}/dashboard/billing?checkout=success`,
    returnUrl: `${base}/dashboard/billing`,
    metadata: { agentplanUserId: target.userId },
  });
  await recordAuditEvent({
    type: "billing.checkout_started",
    userId: target.userId,
    metadata: { provider: "polar", checkoutId: checkout.id, products },
  });
  return checkout.url;
}

/** Customer portal for invoices, payment method, cancellation. null = no customer yet. */
export async function createPortalUrl(
  userId: string,
  config: BillingConfig | null = readBillingConfig(),
): Promise<string | null> {
  if (!config) return null;
  try {
    const session = await getPolarClient(config).customerSessions.create({
      externalCustomerId: userId,
      returnUrl: `${appUrl()}/dashboard/billing`,
    });
    return session.customerPortalUrl;
  } catch (error) {
    if (error instanceof ResourceNotFound) return null;
    throw error;
  }
}

/**
 * Best effort when an account is blocked or deleted: stop charging a customer
 * who can no longer use the service. Failures are logged; the reconcile job
 * and the provider's own retention rules cover the rest.
 */
export async function revokeBillingForUser(
  userId: string,
  reason: "blocked" | "deleted",
  config: BillingConfig | null = readBillingConfig(),
): Promise<void> {
  if (!config) return;
  const polar = getPolarClient(config);
  try {
    if (reason === "deleted") {
      // Cancels active subscriptions and removes the customer record.
      await polar.customers.deleteExternal({ externalId: userId });
      return;
    }
    const subscription = await getSubscriptionForUser(userId);
    if (subscription && CURRENT_STATUSES.has(subscription.status)) {
      await polar.subscriptions.revoke({ id: subscription.subscriptionId });
    }
    await applySubscriptions(userId, [], { config });
  } catch (error) {
    if (error instanceof ResourceNotFound) return;
    console.error(`Polar ${reason} cleanup failed for user`, userId, billingErrorSummary(error));
  }
}

/**
 * Daily safety net: re-reads every active Pro subscription from Polar and every
 * locally mirrored user, so a lost webhook cannot leave someone over- or
 * under-entitled for more than a day.
 */
export async function reconcileSubscriptions(
  deadline: number = Date.now() + 60_000,
  config: BillingConfig | null = readBillingConfig(),
): Promise<{ checked: number; changed: number; skipped: boolean }> {
  if (!config) return { checked: 0, changed: 0, skipped: true };
  const polar = getPolarClient(config);
  const remote = new Map<string, SubscriptionInput[]>();

  let page = 1;
  while (Date.now() < deadline) {
    const response = await polar.subscriptions.list({
      active: true,
      productId: config.productIds,
      limit: 100,
      page,
    });
    for (const subscription of response.result.items) {
      const userId = subscription.customer.externalId?.trim();
      if (!userId) continue;
      const list = remote.get(userId) ?? [];
      list.push(subscriptionInputFromSubscription(subscription));
      remote.set(userId, list);
    }
    if (page >= response.result.pagination.maxPage) break;
    page += 1;
  }

  const local = await getDb()
    .select({ userId: billingSubscriptions.userId })
    .from(billingSubscriptions);
  const userIds = new Set([...remote.keys(), ...local.map((row) => row.userId)]);

  let checked = 0;
  let changed = 0;
  for (const userId of userIds) {
    if (Date.now() >= deadline) break;
    const [exists] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!exists) continue;
    const result = await applySubscriptions(userId, remote.get(userId) ?? [], { config });
    checked += 1;
    if (result.changed) changed += 1;
  }
  return { checked, changed, skipped: false };
}
