import Link from "next/link";
import {
  CheckoutButton,
  PortalButton,
  RefreshSubscriptionButton,
} from "@/components/dashboard/billing-actions";
import { DashboardHeader } from "@/components/dashboard/header";
import { UsageMeter } from "@/components/dashboard/usage-meter";
import { isAdmin, requireUser } from "@/lib/auth/session";
import { isBillingConfigured } from "@/lib/billing/config";
import { limitsForEffectivePlan } from "@/lib/billing/plan";
import {
  getEffectivePlanForUser,
  getSubscriptionForUser,
  listProPlanOffers,
} from "@/lib/billing/service";
import { formatBytes, formatPrice, formatRelativeTime } from "@/lib/format";
import { getUserStorageUsage } from "@/lib/limits/enforce";
import { limitsForPlan } from "@/lib/limits/plans";

export const metadata = { title: "Plan & billing" };

function intervalLabel(interval: string | null): string {
  if (interval === "month") return "/ month";
  if (interval === "year") return "/ year";
  if (interval === "week") return "/ week";
  if (interval === "day") return "/ day";
  return "";
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const billingEnabled = isBillingConfigured();
  const [effective, subscription, usage, offers] = await Promise.all([
    getEffectivePlanForUser(user.id),
    getSubscriptionForUser(user.id),
    getUserStorageUsage(user.id),
    billingEnabled ? listProPlanOffers() : Promise.resolve([]),
  ]);
  const limits = limitsForEffectivePlan(effective);
  const free = limitsForPlan("free");
  const used = usage.committedBytes + usage.reservedBytes;
  const justCheckedOut = params.checkout === "success";
  const hasCurrentSubscription = effective.source === "subscription";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <DashboardHeader email={user.email} isAdmin={isAdmin(user)} billingEnabled={billingEnabled} />

      <section className="flex flex-col gap-3">
        <h1 className="font-mono text-sm text-ink-muted">plan &amp; billing</h1>
        {justCheckedOut && !hasCurrentSubscription ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-lime bg-surface p-4">
            <p className="font-mono text-sm text-ink">
              Thanks! Your subscription is being activated. This usually takes a few seconds.
            </p>
            <RefreshSubscriptionButton />
          </div>
        ) : null}
        <div className="flex flex-col gap-4 rounded-md border border-edge bg-surface p-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-sm text-ink">current plan</span>
            <span
              className={`rounded-sm border px-1.5 py-0.5 font-mono text-xs ${
                effective.plan === "free"
                  ? "border-edge text-ink-muted"
                  : "border-lime/40 bg-lime/5 text-lime"
              }`}
            >
              {effective.plan}
            </span>
            {subscription ? (
              <span className="font-mono text-xs text-ink-faint">
                {subscription.productName} · {subscription.status}
                {subscription.cancelAtPeriodEnd && subscription.currentPeriodEnd
                  ? ` · ends ${formatRelativeTime(subscription.currentPeriodEnd)}`
                  : subscription.currentPeriodEnd
                    ? ` · renews ${formatRelativeTime(subscription.currentPeriodEnd)}`
                    : ""}
              </span>
            ) : effective.plan !== "free" ? (
              <span className="font-mono text-xs text-ink-faint">granted by an administrator</span>
            ) : null}
          </div>
          <div className="grid grid-cols-1 gap-x-6 gap-y-3 font-mono text-xs sm:grid-cols-3">
            <UsageMeter
              label="storage"
              used={used}
              limit={limits.maxStorageBytes}
              format={formatBytes}
            />
            <div className="flex flex-col gap-1.5">
              <span className="text-ink-faint">drafts</span>
              <span className="text-ink">
                {limits.maxDrafts === null ? (
                  <span className="text-lime">unlimited</span>
                ) : (
                  `up to ${limits.maxDrafts}`
                )}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-ink-faint">versions per draft</span>
              <span className="text-ink">
                {limits.keepVersionsByKind.html === null ? (
                  <span className="text-lime">unlimited</span>
                ) : (
                  `HTML ${limits.keepVersionsByKind.html} · image ${limits.keepVersionsByKind.image} · video ${limits.keepVersionsByKind.video}`
                )}
              </span>
            </div>
          </div>
          {billingEnabled && (subscription || hasCurrentSubscription) ? (
            <div className="flex flex-wrap items-center gap-3">
              <PortalButton />
              <RefreshSubscriptionButton />
              <span className="font-mono text-xs text-ink-faint">
                Invoices, payment method, and cancellation are handled by Polar.
              </span>
            </div>
          ) : null}
        </div>
      </section>

      {!billingEnabled ? (
        <p className="font-mono text-xs text-ink-faint">
          This deployment has no payment provider configured. Plans are assigned by an
          administrator.
        </p>
      ) : effective.plan === "unlimited" ? (
        <p className="font-mono text-xs text-ink-faint">
          Your account has no limits. There is nothing to upgrade.
        </p>
      ) : offers.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-mono text-sm text-ink-muted">
            {hasCurrentSubscription ? "change plan" : "upgrade"}
          </h2>
          <p className="max-w-xl text-sm text-ink-muted">
            Pro removes the draft, version, and token caps. You pay only for storage; drafts are
            kept for as long as you keep the plan. Cancel any time — existing uploads and links stay
            available, and the Free storage limit of {formatBytes(free.maxStorageBytes ?? 0)}{" "}
            applies to new uploads afterwards.
          </p>
          <ul role="list" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {offers.map((offer) => {
              const isCurrent =
                subscription?.productId === offer.productId && hasCurrentSubscription;
              return (
                <li
                  key={offer.productId}
                  className={`flex flex-col gap-3 rounded-md border bg-surface p-4 ${
                    isCurrent ? "border-lime/60" : "border-edge"
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium text-ink">{offer.name}</span>
                    {offer.amount !== null && offer.currency ? (
                      <span className="font-mono text-sm text-ink">
                        {formatPrice(offer.amount, offer.currency)}
                        <span className="text-ink-faint">
                          {" "}
                          {intervalLabel(offer.recurringInterval)}
                        </span>
                      </span>
                    ) : null}
                  </div>
                  <ul className="flex flex-col gap-1 font-mono text-xs text-ink-muted">
                    <li>
                      <span className="text-lime">{formatBytes(offer.storageBytes)}</span> storage
                    </li>
                    <li>unlimited drafts, versions, and API tokens</li>
                    <li>higher upload rate limits</li>
                  </ul>
                  {offer.description ? (
                    <p className="text-xs text-ink-faint">{offer.description}</p>
                  ) : null}
                  {isCurrent ? (
                    <span className="font-mono text-xs text-lime">current plan</span>
                  ) : hasCurrentSubscription ? (
                    <span className="font-mono text-xs text-ink-faint">
                      Switch plans from the subscription portal.
                    </span>
                  ) : (
                    <CheckoutButton productId={offer.productId} label={`get ${offer.name}`} />
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : hasCurrentSubscription ? null : (
        <p className="font-mono text-xs text-ink-faint">
          Plans are temporarily unavailable. Please try again later.
        </p>
      )}

      <p className="font-mono text-xs text-ink-faint">
        Questions about a charge? Contact the operator of this deployment.{" "}
        <Link href="/dashboard" className="text-ink-muted hover:text-lime">
          ← back to dashboard
        </Link>
      </p>
    </main>
  );
}
