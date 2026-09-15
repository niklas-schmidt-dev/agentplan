import { InvalidGroupCursorError } from "@/lib/api/group-cursor";
import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
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
import { uuidSchema, visibilitySchema } from "@/lib/validation/api";
import {
  getGroupForOwner,
  getGroupPathsForOwner,
  listGroupsPageForOwner,
} from "@/db/queries/groups";
import {
  GroupActions,
  GroupBreadcrumbs,
  DraftCheckbox,
  DraftSelection,
  NewGroupButton,
} from "./group-controls";
import { GroupNavigation } from "./group-navigation";
import { GroupCards } from "./group-cards";
import { FileFilters } from "./file-filters";

export type LibrarySearchParams = {
  q?: string;
  visibility?: string;
  recent?: string;
  cursor?: string;
  groupId?: string;
  includeDescendants?: string;
  groupsCursor?: string;
};

export async function LibraryPage({
  searchParams,
  selectedGroupId,
}: {
  searchParams: Promise<LibrarySearchParams>;
  selectedGroupId?: string;
}) {
  const user = await requireUser();
  const params = await searchParams;
  if (selectedGroupId && !uuidSchema.safeParse(selectedGroupId).success) notFound();
  const group = selectedGroupId ? await getGroupForOwner(selectedGroupId, user.id) : null;
  if (selectedGroupId && !group) notFound();
  const ungrouped = !selectedGroupId && params.groupId === "none";
  const baseUrl = selectedGroupId ? `/dashboard/groups/${selectedGroupId}` : "/dashboard";
  const groupId = group?.id ?? (ungrouped ? null : undefined);
  const includeDescendants =
    !!group &&
    (params.includeDescendants === "1" ||
      (params.includeDescendants !== "0" && !!params.q?.trim()));
  const visibility = visibilitySchema.safeParse(params.visibility);
  const search = params.q?.trim() || undefined;

  const billingEnabled = isBillingConfigured();
  const [page, usage, effective, intents, counts, roots, children] = await Promise.all([
    listDraftsPageForOwner(user.id, {
      search,
      groupId,
      includeDescendants,
      limit: 50,
      cursor: params.cursor,
      visibility: visibility.success ? visibility.data : undefined,
      updatedWithinDays: params.recent === "1" ? 7 : undefined,
    }),
    getUserStorageUsage(user.id),
    getEffectivePlanForUser(user.id),
    listPendingUploadIntents(user.id),
    getUserUsageCounts(user.id),
    listGroupsPageForOwner(user.id, { limit: 30 }),
    group
      ? listGroupsPageForOwner(user.id, {
          parentId: group.id,
          limit: 12,
          cursor: params.groupsCursor,
        })
      : Promise.resolve(null),
  ]).catch((error: unknown) => {
    if (error instanceof InvalidDraftCursorError || error instanceof InvalidGroupCursorError) {
      const clean = new URLSearchParams();
      if (params.q) clean.set("q", params.q);
      if (params.visibility) clean.set("visibility", params.visibility);
      if (params.recent) clean.set("recent", params.recent);
      if (ungrouped) clean.set("groupId", "none");
      if (group) clean.set("includeDescendants", includeDescendants ? "1" : "0");
      redirect(`${baseUrl}?${clean}`);
    }
    throw error;
  });
  const drafts = page.drafts;
  const paths = await getGroupPathsForOwner(user.id, [
    ...new Set(drafts.flatMap((draft) => (draft.groupId ? [draft.groupId] : []))),
  ]);
  const viewCounts = getViewCountsForOwner(
    user.id,
    drafts.map((draft) => draft.id),
  ).catch(() => null);
  const pageUrl = (
    cursor: string | null,
    groupsCursor: string | null = params.groupsCursor ?? null,
  ) => {
    const query = new URLSearchParams();
    if (search) query.set("q", search);
    if (visibility.success) query.set("visibility", visibility.data);
    if (params.recent === "1") query.set("recent", "1");
    if (cursor) query.set("cursor", cursor);
    if (ungrouped) query.set("groupId", "none");
    if (group) query.set("includeDescendants", includeDescendants ? "1" : "0");
    if (groupsCursor) query.set("groupsCursor", groupsCursor);
    return `${baseUrl}?${query.toString()}`;
  };
  const limits = limitsForEffectivePlan(effective);
  const storageUsed = usage.committedBytes + usage.reservedBytes;
  const nearStorageLimit =
    limits.maxStorageBytes !== null && storageUsed >= limits.maxStorageBytes * 0.8;
  const nearDraftLimit = limits.maxDrafts !== null && counts.draftCount >= limits.maxDrafts * 0.8;
  const upgradeHref =
    billingEnabled && effective.plan === "free" ? "/dashboard/billing" : undefined;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-7xl flex-col gap-6 px-6 py-8">
      <DashboardHeader email={user.email} isAdmin={isAdmin(user)} billingEnabled={billingEnabled} />

      <div className="flex min-w-0 flex-col gap-6 lg:flex-row">
        <GroupNavigation
          key={JSON.stringify(roots) + selectedGroupId}
          roots={roots}
          activeId={selectedGroupId}
          ungrouped={ungrouped}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <section className="flex flex-col gap-4">
            {group ? <GroupBreadcrumbs path={group.path} /> : null}
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="break-words text-2xl font-semibold">
                  {group?.name ?? (ungrouped ? "Ungrouped" : "All files")}
                </h1>
                {group?.description ? (
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm text-ink-muted">
                    {group.description}
                  </p>
                ) : (
                  <p className="mt-2 text-sm text-ink-muted">
                    {group
                      ? "Plans, images, videos, and subgroups in one place."
                      : ungrouped
                        ? "Files without a group. Select files to organize them together."
                        : "Your plans, images, and videos across every group."}
                  </p>
                )}
              </div>
              {!group ? <NewGroupButton /> : null}
            </div>
            {group ? <GroupActions group={group} /> : null}
          </section>
          {children ? (
            <section aria-label="Subgroups" className="flex flex-col gap-3">
              <h2 className="font-mono text-sm text-ink-muted">Subgroups</h2>
              {children.groups.length ? (
                <GroupCards groups={children.groups} />
              ) : (
                <p className="text-sm text-ink-faint">
                  No subgroups yet. Add one to organize this group further.
                </p>
              )}
              {children.nextCursor || params.groupsCursor ? (
                <nav aria-label="Subgroup pages" className="flex gap-4 font-mono text-xs text-lime">
                  {params.groupsCursor ? (
                    <Link href={pageUrl(params.cursor ?? null, null)}>First groups</Link>
                  ) : null}
                  {children.nextCursor ? (
                    <Link href={pageUrl(params.cursor ?? null, children.nextCursor)}>
                      More groups →
                    </Link>
                  ) : null}
                </nav>
              ) : null}
            </section>
          ) : null}

          <details
            className="rounded-md border border-edge bg-surface p-4"
            open={drafts.length === 0}
          >
            <summary className="cursor-pointer font-mono text-sm text-lime">+ new draft</summary>
            <div className="pt-4">
              <NewDraftForm
                key={groupId ?? "ungrouped"}
                upgradeHref={upgradeHref}
                defaultGroupId={group?.id ?? null}
                defaultGroupPath={group?.path ?? []}
              />
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
                {nearStorageLimit || nearDraftLimit
                  ? "almost at the limit — see pro →"
                  : "see pro →"}
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

          <h2 className="font-mono text-sm text-ink-muted">
            {group
              ? includeDescendants
                ? "Files including subgroups"
                : `Files here · ${group.directDraftCount}`
              : "Files"}
          </h2>
          <FileFilters
            key={`${groupId}:${search ?? ""}:${params.visibility}:${params.recent}:${includeDescendants}`}
            search={search}
            visibility={visibility.success ? visibility.data : undefined}
            recent={params.recent === "1"}
            groupId={groupId}
            includeDescendants={includeDescendants}
          />

          {drafts.length === 0 ? (
            <div className="rounded-md border border-dashed border-edge p-6 text-sm text-ink-faint">
              <p>
                {search || visibility.success || params.recent
                  ? "No files match these filters."
                  : group
                    ? "No files here yet. Upload a file or move existing files into this group."
                    : ungrouped
                      ? "Every file has a group. New uploads can also stay ungrouped."
                      : "No drafts yet. Upload a plan, image, or video to get started."}
              </p>
              {group && !search ? (
                <Link href="/dashboard" className="mt-3 inline-block font-mono text-xs text-lime">
                  Organize existing files →
                </Link>
              ) : null}
            </div>
          ) : (
            <DraftSelection
              key={`${baseUrl}:${JSON.stringify(params)}:${drafts.map((draft) => `${draft.id}:${draft.groupId}`).join(",")}`}
              draftIds={drafts.map((draft) => draft.id)}
              initialPath={group?.path}
            >
              <ul
                role="list"
                className="flex flex-col divide-y divide-edge rounded-md border border-edge bg-surface"
              >
                {drafts.map((draft) => (
                  <li key={draft.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
                    <DraftCheckbox id={draft.id} title={draft.title} />
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/dashboard/drafts/${draft.id}`}
                        className="block truncate font-medium text-ink transition-colors hover:text-lime"
                      >
                        {draft.title}
                      </Link>
                      {draft.groupId && paths[draft.groupId] ? (
                        <Link
                          href={`/dashboard/groups/${draft.groupId}`}
                          title={paths[draft.groupId]!.map((item) => item.name).join(" / ")}
                          className="mt-1 block truncate font-mono text-xs text-ink-muted hover:text-lime"
                        >
                          {paths[draft.groupId]!.map((item) => item.name).join(" / ")}
                        </Link>
                      ) : !group ? (
                        <span className="font-mono text-xs text-ink-faint">Ungrouped</span>
                      ) : null}
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
                        {draft.expiresAt ? (
                          <span className="ml-2" title={draft.expiresAt.toISOString()}>
                            expires {draft.expiresAt.toISOString().replace("T", " ").slice(0, 16)}{" "}
                            UTC
                          </span>
                        ) : null}
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
            </DraftSelection>
          )}
          {page.previousCursor || page.nextCursor || params.cursor ? (
            <nav
              aria-label="Draft pages"
              className="flex items-center gap-4 font-mono text-sm text-lime"
            >
              {params.cursor ? <Link href={pageUrl(null)}>first page</Link> : null}
              {page.previousCursor ? (
                <Link href={pageUrl(page.previousCursor)}>← previous</Link>
              ) : null}
              {page.nextCursor ? <Link href={pageUrl(page.nextCursor)}>next →</Link> : null}
            </nav>
          ) : null}
        </div>
      </div>
    </main>
  );
}
