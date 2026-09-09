import type { BillingSubscription, UserPlan } from "@/db/schema";
import { defaultProStorageBytes, limitsForPlan, type EffectiveLimits } from "@/lib/limits/plans";

/**
 * A lapsed period is tolerated briefly so a delayed renewal webhook does not
 * knock a paying user back to Free. The daily reconcile job refreshes the
 * period end (or removes the row) long before this window closes.
 */
export const SUBSCRIPTION_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

const CURRENT_STATUSES = new Set(["active", "trialing"]);

export type SubscriptionSnapshot = Pick<
  BillingSubscription,
  "status" | "storageBytes" | "currentPeriodEnd" | "endsAt" | "cancelAtPeriodEnd"
>;

export type EffectivePlan = {
  plan: UserPlan;
  /** null = unlimited storage. */
  storageBytes: number | null;
  /** Where the plan came from: the operator-granted column or the billing provider. */
  source: "granted" | "subscription";
};

export function isSubscriptionCurrent(
  subscription: SubscriptionSnapshot | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!subscription) return false;
  if (!CURRENT_STATUSES.has(subscription.status)) return false;
  if (subscription.endsAt && subscription.endsAt.getTime() <= now.getTime()) return false;
  if (
    subscription.currentPeriodEnd &&
    subscription.currentPeriodEnd.getTime() + SUBSCRIPTION_GRACE_MS <= now.getTime()
  ) {
    return false;
  }
  return true;
}

/**
 * Combines the operator-granted plan with the mirrored billing subscription.
 * Billing can only ever raise a user: "unlimited" stays unlimited, and a Pro
 * grant keeps at least the default Pro storage even if the product sells less.
 */
export function resolveEffectivePlan(
  grantedPlan: UserPlan,
  subscription: SubscriptionSnapshot | null | undefined,
  now: Date = new Date(),
): EffectivePlan {
  if (grantedPlan === "unlimited") {
    return { plan: "unlimited", storageBytes: null, source: "granted" };
  }
  const current = isSubscriptionCurrent(subscription, now) ? subscription : null;
  if (grantedPlan === "pro") {
    const granted = defaultProStorageBytes();
    return current && current.storageBytes > granted
      ? { plan: "pro", storageBytes: current.storageBytes, source: "subscription" }
      : { plan: "pro", storageBytes: granted, source: "granted" };
  }
  if (current) {
    return { plan: "pro", storageBytes: current.storageBytes, source: "subscription" };
  }
  return { plan: "free", storageBytes: limitsForPlan("free").maxStorageBytes, source: "granted" };
}

export function limitsForEffectivePlan(effective: EffectivePlan): EffectiveLimits {
  return limitsForPlan(effective.plan, effective.storageBytes);
}
