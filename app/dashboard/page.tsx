import { Suspense } from "react";
import { redirect } from "next/navigation";
import { InvalidDraftCursorError } from "@/lib/api/draft-cursor";
import { DraftViewCount } from "@/components/dashboard/draft-view-count";
import Link from "next/link";
import { listDraftsPageForOwner } from "@/db/queries/drafts";
import { CopyButton } from "@/components/dashboard/copy-button";
import { DashboardHeader } from "@/components/dashboard/header";
import { NewDraftForm, PendingUploads } from "@/components/dashboard/upload-form";
import { UsageMeter } from "@/components/dashboard/usage-meter";
import { getViewCountsForOwner } from "@/lib/analytics/queries";
import { isAdmin, requireUser } from "@/lib/auth/session";
import { isBillingConfigured } from "@/lib/billing/config";
import { limitsForEffectivePlan } from "@/lib/billing/plan";
import { getEffectivePlanForUser } from "@/lib/billing/service";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { getUserStorageUsage, getUserUsageCounts } from "@/lib/limits/enforce";
import { listPendingUploadIntents } from "@/lib/uploads/service";
import { draftUrl } from "@/lib/urls";
import { visibilitySchema } from "@/lib/validation/api";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; visibility?: string; recent?: string; cursor?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const visibility = visibilitySchema.safeParse(params.visibility);
  const search = params.q?.trim() || undefined;

  const billingEnabled = isBillingConfigured();
  const [page, usage, effective, intents, counts] = await Promise.all([
    listDraftsPageForOwner(user.id, {
      search,
      limit: 50,
      cursor: params.cursor,
      visibility: visibility.success ? visibility.data : undefined,
      updatedWithinDays: params.recent === "1" ? 7 : undefined,
    }),
    getUserStorageUsage(user.id),
    getEffectivePlanForUser(user.id),
    listPendingUploadIntents(user.id),
    getUserUsageCounts(user.id),
  ]).catch((error: unknown) => {
    if (error instanceof InvalidDraftCursorError) redirect("/dashboard");
    throw error;
  });
  const drafts = page.drafts;
  const viewCounts = getViewCountsForOwner(
    user.id,
    drafts.map((draft) => draft.id),
  ).catch(() => null);
  const pageUrl = (cursor: string | null) => {
    const query = new URLSearchParams();
    if (search) query.set("q", search);
    if (visibility.success) query.set("visibility", visibility.data);
    if (params.recent === "1") query.set("recent", "1");
    if (cursor) query.set("cursor", cursor);
    return `/dashboard?${query.toString()}`;
  };
  const limits = limitsForEffectivePlan(effective);
  const storageUsed = usage.committedBytes + usage.reservedBytes;
  const nearStorageLimit =
    limits.maxStorageBytes !== null && storageUsed >= limits.maxStorageBytes * 0.8;
  const nearDraftLimit = limits.maxDrafts !== null && counts.draftCount >= limits.maxDrafts * 0.8;
  const upgradeHref =
    billingEnabled && effective.plan === "free" ? "/dashboard/billing" : undefined;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 px-6 py-8">
      <DashboardHeader email={user.email} isAdmin={isAdmin(user)} billingEnabled={billingEnabled} />

      <details className="rounded-md border border-edge bg-surface p-4" open={drafts.length === 0}>
        <summary className="cursor-pointer font-mono text-sm text-lime">+ new draft</summary>
        <div className="pt-4">
          <NewDraftForm upgradeHref={upgradeHref} />
        </div>
      </details>

      <section className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 rounded-md border border-edge bg-surface px-4 py-3 font-mono text-xs">
        <div className="grid w-full max-w-lg grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
          <UsageMeter
            label={`storage · ${effective.plan} plan`}
            used={storageUsed}
            limit={limits.maxStorageBytes}
            format={formatBytes}
            detail={
              usage.reservedBytes > 0
                ? `${formatBytes(usage.committedBytes)} committed + ${formatBytes(usage.reservedBytes)} reserved`
                : undefined
            }
          />
          <UsageMeter label="drafts" used={counts.draftCount} limit={limits.maxDrafts} />
        </div>
        {upgradeHref ? (
          <Link
            href={upgradeHref}
            className={`rounded border px-3 py-1.5 transition-colors ${
              nearStorageLimit || nearDraftLimit
                ? "border-lime text-lime hover:bg-lime/10"
                : "border-edge text-ink-muted hover:border-lime hover:text-lime"
            }`}
          >
            {nearStorageLimit || nearDraftLimit ? "almost at the limit — see pro →" : "see pro →"}
          </Link>
        ) : null}
      </section>

      <PendingUploads
        intents={intents.map((intent) => ({
          id: intent.id,
          filename: intent.originalFilename,
          reservedBytes: intent.expectedBytes,
          expiresAt: intent.expiresAt.toISOString(),
          fileCount: intent.fileCount,
          mode: intent.mode,
        }))}
      />

      <form method="GET" className="flex flex-wrap items-center gap-3 font-mono text-xs">
        <label className="flex items-center gap-2 text-ink-muted">
          <span className="sr-only">Search by title</span>
          <input
            type="search"
            name="q"
            defaultValue={search ?? ""}
            placeholder="search titles…"
            className="w-56 rounded border border-edge bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint"
          />
        </label>
        <select
          name="visibility"
          defaultValue={visibility.success ? visibility.data : ""}
          className="rounded border border-edge bg-surface px-2 py-1.5 text-ink-muted"
          aria-label="Filter by visibility"
        >
          <option value="">all visibilities</option>
          <option value="public">public</option>
          <option value="private">private</option>
          <option value="password">password</option>
        </select>
        <label className="flex items-center gap-1.5 text-ink-muted">
          <input
            type="checkbox"
            name="recent"
            value="1"
            defaultChecked={params.recent === "1"}
            className="accent-lime"
          />
          updated this week
        </label>
        <button
          type="submit"
          className="rounded border border-edge px-3 py-1.5 text-ink-muted transition-colors hover:border-lime hover:text-lime"
        >
          filter
        </button>
      </form>

      {drafts.length === 0 ? (
        <p className="font-mono text-sm text-ink-faint">
          No drafts{search || visibility.success || params.recent ? " match these filters" : " yet"}
          .
        </p>
      ) : (
        <ul
          role="list"
          className="flex flex-col divide-y divide-edge rounded-md border border-edge bg-surface"
        >
          {drafts.map((draft) => (
            <li key={draft.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
              <div className="min-w-0 flex-1">
                <Link
                  href={`/dashboard/drafts/${draft.id}`}
                  className="block truncate font-medium text-ink transition-colors hover:text-lime"
                >
                  {draft.title}
                </Link>
                <p className="font-mono text-xs text-ink-faint">
                  <span className={draft.visibility === "public" ? "text-lime" : ""}>
                    {draft.visibility === "private"
                      ? "Only you"
                      : draft.visibility === "public"
                        ? "Anyone with the link"
                        : "Link + password"}
                  </span>
                  {" · "}
                  {draft.kind}
                  {" · "}
                  {draft.currentVersion
                    ? `v${draft.currentVersion.versionNumber} · ${formatBytes(draft.currentVersion.sizeBytes)}${draft.currentVersion.isBundle ? " · HTML + media" : ""}`
                    : "no version"}
                  {" · updated "}
                  {formatRelativeTime(draft.updatedAt)}
                  {" · "}
                  <Suspense fallback={<span>loading views…</span>}>
                    <DraftViewCount counts={viewCounts} draftId={draft.id} />
                  </Suspense>
                </p>
              </div>
              <div className="flex items-center gap-2">
                <CopyButton value={draftUrl(draft.slug)} />
                <a
                  href={`/p/${draft.slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded border border-edge px-2 py-1 font-mono text-xs text-ink-muted transition-colors hover:border-lime hover:text-lime"
                >
                  open ↗
                </a>
                <Link
                  href={`/dashboard/drafts/${draft.id}`}
                  className="rounded border border-edge px-2 py-1 font-mono text-xs text-ink-muted transition-colors hover:border-lime hover:text-lime"
                >
                  more…
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
      {page.previousCursor || page.nextCursor || params.cursor ? (
        <nav
          aria-label="Draft pages"
          className="flex items-center gap-4 font-mono text-sm text-lime"
        >
          {params.cursor ? <Link href={pageUrl(null)}>first page</Link> : null}
          {page.previousCursor ? <Link href={pageUrl(page.previousCursor)}>← previous</Link> : null}
          {page.nextCursor ? <Link href={pageUrl(page.nextCursor)}>next →</Link> : null}
        </nav>
      ) : null}
    </main>
  );
}
