import Link from "next/link";
import { offerPrice, PlanComparison, type PlanColumn } from "@/components/plan-comparison";
import { getOptionalUser } from "@/lib/auth/session";
import { isBillingConfigured } from "@/lib/billing/config";
import { listProPlanOffers } from "@/lib/billing/service";
import { formatBytes } from "@/lib/format";
import { limitsForPlan } from "@/lib/limits/plans";

export const metadata = {
  title: "Pricing",
  description: "Free for small plans. Pro when storage is the only thing in the way.",
};

const promises = [
  {
    index: "01",
    name: "Links do not expire",
    detail:
      "A published draft stays reachable on Free and on Pro. Limits only gate new uploads, never existing ones.",
  },
  {
    index: "02",
    name: "Pro is storage, nothing else",
    detail:
      "Drafts, versions, and API tokens are uncapped. You pay for the gigabytes your uploads occupy.",
  },
  {
    index: "03",
    name: "Cancel and keep everything",
    detail:
      "Polar bills and invoices. Cancel any time; your uploads stay online and Free limits apply to what you add next.",
  },
];

export default async function PricingPage() {
  const [user, offers] = await Promise.all([
    getOptionalUser(),
    isBillingConfigured() ? listProPlanOffers() : Promise.resolve([]),
  ]);
  const free = limitsForPlan("free");
  const signedIn = Boolean(user);
  const buttonClass =
    "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 font-mono text-xs font-medium transition-colors";

  const columns: PlanColumn[] = [
    {
      key: "free",
      name: "free",
      price: "€0",
      limits: free,
      highlighted: false,
      action: (
        <Link
          href={signedIn ? "/dashboard" : "/login"}
          className={`${buttonClass} border-edge text-ink-muted hover:border-lime hover:text-lime`}
        >
          {signedIn ? "open dashboard" : "start free"}
        </Link>
      ),
    },
    ...offers.map<PlanColumn>((offer) => ({
      key: offer.productId,
      name: offer.name,
      price: offerPrice(offer),
      limits: limitsForPlan("pro", offer.storageBytes),
      highlighted: true,
      action: (
        <Link
          href={signedIn ? "/dashboard/billing" : "/login"}
          className={`${buttonClass} border-lime bg-lime text-canvas hover:bg-lime-dim`}
        >
          get pro →
        </Link>
      ),
    })),
  ];

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col px-6 py-10 sm:py-16">
      <header className="flex items-center justify-between">
        <Link
          href="/"
          className="font-mono text-sm text-ink-muted transition-colors hover:text-lime"
        >
          <span className="text-lime">agentplan</span>.app
        </Link>
        <span className="font-mono text-xs uppercase tracking-[0.22em] text-ink-faint">
          pricing
        </span>
      </header>

      <section className="flex flex-col gap-7 py-16">
        <div className="flex items-center gap-3 font-mono text-xs uppercase tracking-[0.2em] text-lime">
          <span className="h-px w-8 bg-lime" />
          two plans
        </div>
        <h1 className="max-w-2xl text-4xl font-semibold tracking-[-0.04em] text-ink sm:text-6xl">
          Free until storage
          <br />
          gets in the way.
        </h1>
        <p className="max-w-xl text-base leading-7 text-ink-muted">
          Free gives every account {formatBytes(free.maxStorageBytes ?? 0)},{" "}
          {free.maxDrafts ?? "unlimited"} drafts, and {free.maxActiveTokens ?? "unlimited"} API
          tokens. Pro removes the counts and sells storage by the gigabyte, billed by Polar so tax
          and invoices are handled for you.
        </p>
      </section>

      {offers.length > 0 ? (
        <PlanComparison columns={columns} />
      ) : (
        <PlanComparison columns={[columns[0]!]} />
      )}
      {offers.length === 0 ? (
        <p className="mt-6 font-mono text-xs text-ink-faint">
          {isBillingConfigured()
            ? "Pro plans could not be loaded right now."
            : "This deployment sells no plans. Administrators assign them directly."}
        </p>
      ) : null}

      <ol className="mt-16 border-y border-edge">
        {promises.map((promise) => (
          <li
            key={promise.index}
            className="grid grid-cols-[2.5rem_1fr] gap-4 border-b border-edge py-6 last:border-b-0"
          >
            <span className="font-mono text-xs text-lime">{promise.index}</span>
            <div className="flex flex-col gap-2">
              <h2 className="font-mono text-sm text-ink">{promise.name}</h2>
              <p className="text-sm leading-6 text-ink-muted">{promise.detail}</p>
            </div>
          </li>
        ))}
      </ol>

      <footer className="mt-10 flex flex-col gap-3 pt-6 font-mono text-xs text-ink-faint sm:flex-row sm:items-center sm:justify-between">
        <span>MIT licensed · self-hosting has no plans at all</span>
        <Link href="/self-host" className="transition-colors hover:text-lime">
          deploy your own →
        </Link>
      </footer>
    </main>
  );
}
