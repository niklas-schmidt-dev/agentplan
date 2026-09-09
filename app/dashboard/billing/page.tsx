import Link from "next/link";
import {
  CheckoutButton,
  PortalButton,
  RefreshSubscriptionButton,
} from "@/components/dashboard/billing-actions";
import { DashboardHeader } from "@/components/dashboard/header";
import { UsageMeter } from "@/components/dashboard/usage-meter";
import { offerPrice, PlanComparison, type PlanColumn } from "@/components/plan-comparison";
import { isAdmin, requireUser } from "@/lib/auth/session";
import { isBillingConfigured } from "@/lib/billing/config";
import { limitsForEffectivePlan } from "@/lib/billing/plan";
import {
  getEffectivePlanForUser,
  getSubscriptionForUser,
  listProPlanOffers,
} from "@/lib/billing/service";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { getUserStorageUsage, getUserUsageCounts } from "@/lib/limits/enforce";
import { limitsForPlan } from "@/lib/limits/plans";

export const metadata = { title: "Plan" };

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const billingEnabled = isBillingConfigured();
  const [effective, subscription, usage, counts, offers] = await Promise.all([
    getEffectivePlanForUser(user.id),
    getSubscriptionForUser(user.id),
    getUserStorageUsage(user.id),
    getUserUsageCounts(user.id),
    billingEnabled ? listProPlanOffers() : Promise.resolve([]),
  ]);
  const limits = limitsForEffectivePlan(effective);
  const free = limitsForPlan("free");
  const storageUsed = usage.committedBytes + usage.reservedBytes;
  const justCheckedOut = params.checkout === "success";
  const paying = effective.source === "subscription";
  const canUpgrade = billingEnabled && effective.plan === "free";

  const columns: PlanColumn[] = [
    {
      key: "free",
      name: "free",
      price: "€0",
      limits: free,
      highlighted: false,
      action:
        effective.plan === "free" ? (
          <span className="font-mono text-xs text-ink-faint">your plan</span>
        ) : undefined,
    },
    ...offers.map<PlanColumn>((offer) => {
      const current = paying && subscription?.productId === offer.productId;
      return {
        key: offer.productId,
        name: offer.name,
        price: offerPrice(offer),
        limits: limitsForPlan("pro", offer.storageBytes),
        highlighted: true,
        action: current ? (
          <span className="font-mono text-xs text-lime">your plan</span>
        ) : paying ? (
          <span className="font-mono text-xs text-ink-faint">switch in the portal</span>
        ) : effective.plan === "free" ? (
          <CheckoutButton productId={offer.productId} label="get pro" />
        ) : undefined,
      };
    }),
  ];

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col gap-10 px-6 py-8">
      <DashboardHeader email={user.email} isAdmin={isAdmin(user)} billingEnabled={billingEnabled} />

      {justCheckedOut && !paying ? (
        <aside
          role="status"
          className="rise flex flex-wrap items-center justify-between gap-3 border-l-2 border-lime bg-surface px-4 py-3"
        >
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.16em] text-lime">
              payment received
            </p>
            <p className="mt-1 text-sm text-ink-muted">
              Pro switches on as soon as Polar confirms it, usually within seconds.
            </p>
          </div>
          <RefreshSubscriptionButton />
        </aside>
      ) : null}

      <section className="grid gap-8 md:grid-cols-[1fr_auto] md:items-start">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3 font-mono text-xs uppercase tracking-[0.2em] text-lime">
            <span className="h-px w-8 bg-lime" />
            {effective.plan} plan
          </div>
          <h1 className="text-3xl font-semibold tracking-[-0.03em] text-ink sm:text-4xl">
            {effective.plan === "free"
              ? "Everything you publish stays up."
              : effective.plan === "pro"
                ? "Room to publish everything."
                : "No limits on this account."}
          </h1>
          <p className="max-w-lg text-sm leading-6 text-ink-muted">
            {effective.plan === "free"
              ? "Links never expire on Free. Each draft keeps one version; when a limit is reached, new uploads wait until you make space or move to Pro."
              : effective.plan === "pro"
                ? "Version history, restore, drafts, and tokens are uncapped. Only storage counts, and you can see exactly how much is left."
                : "This account was granted the unlimited plan by an administrator."}
          </p>
          {subscription ? (
            <p className="font-mono text-xs text-ink-faint">
              {subscription.productName} · {subscription.status}
              {subscription.currentPeriodEnd
                ? subscription.cancelAtPeriodEnd
                  ? ` · ends ${formatRelativeTime(subscription.currentPeriodEnd)}`
                  : ` · renews ${formatRelativeTime(subscription.currentPeriodEnd)}`
                : ""}
            </p>
          ) : effective.plan !== "free" ? (
            <p className="font-mono text-xs text-ink-faint">granted by an administrator</p>
          ) : null}
          {billingEnabled && (subscription || paying) ? (
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <PortalButton />
              <RefreshSubscriptionButton />
            </div>
          ) : null}
        </div>

        <dl className="grid min-w-56 grid-cols-1 gap-4 border-l border-edge pl-6 font-mono text-xs">
          <UsageMeter
            label="storage"
            used={storageUsed}
            limit={limits.maxStorageBytes}
            format={formatBytes}
          />
          <UsageMeter label="drafts" used={counts.draftCount} limit={limits.maxDrafts} />
          <UsageMeter label="api tokens" used={counts.tokenCount} limit={limits.maxActiveTokens} />
        </dl>
      </section>

      {!billingEnabled ? (
        <p className="border-t border-edge pt-6 font-mono text-xs text-ink-faint">
          This deployment has no payment provider. Plans are assigned by an administrator.
        </p>
      ) : effective.plan === "unlimited" ? null : offers.length > 0 ? (
        <section className="flex flex-col gap-6">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
              {canUpgrade ? "compare" : "plans"}
            </h2>
            <span className="font-mono text-xs text-ink-faint">
              prices include VAT where it applies · cancel any time
            </span>
          </div>
          <PlanComparison columns={columns} />
          <p className="max-w-2xl text-sm leading-6 text-ink-muted">
            Pro is billed by Polar, which handles tax and invoices. If you cancel, every draft,
            version, and link you published stays online; only new uploads go back to the Free
            limits.
          </p>
        </section>
      ) : paying ? null : (
        <p className="border-t border-edge pt-6 font-mono text-xs text-ink-faint">
          Plans could not be loaded. Try again in a moment.
        </p>
      )}

      <p className="font-mono text-xs text-ink-faint">
        <Link href="/dashboard" className="text-ink-muted transition-colors hover:text-lime">
          ← dashboard
        </Link>
      </p>
    </main>
  );
}
