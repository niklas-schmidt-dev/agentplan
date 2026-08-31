import { notFound } from "next/navigation";
import {
  deleteDraftAction,
  renameDraftAction,
  restoreVersionAction,
} from "@/app/dashboard/actions";
import { CopyButton } from "@/components/dashboard/copy-button";
import { DangerButton } from "@/components/dashboard/danger-button";
import { DashboardHeader } from "@/components/dashboard/header";
import { StatTile } from "@/components/dashboard/stat-tile";
import { NewVersionForm } from "@/components/dashboard/upload-form";
import { ViewSparkline } from "@/components/dashboard/view-sparkline";
import { VisibilityControls } from "@/components/dashboard/visibility-controls";
import { getDraftForOwner, listVersions } from "@/db/queries/drafts";
import { getDraftViewStats } from "@/lib/analytics/queries";
import { isAdmin, requireUser } from "@/lib/auth/session";
import { formatBytes, formatRelativeTime, shortHash } from "@/lib/format";
import { draftUrl } from "@/lib/urls";
import { uuidSchema } from "@/lib/validation/api";

export const metadata = { title: "Draft" };

export default async function DraftDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const rawId = uuidSchema.safeParse((await params).id);
  if (!rawId.success) notFound();
  const draft = await getDraftForOwner(rawId.data, user.id);
  if (!draft) notFound();
  const [versions, views] = await Promise.all([
    listVersions(draft.id),
    getDraftViewStats(draft.id),
  ]);
  const url = draftUrl(draft.slug);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 px-6 py-8">
      <DashboardHeader email={user.email} isAdmin={isAdmin(user)} />

      <section className="flex flex-col gap-4">
        <form action={renameDraftAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="draftId" value={draft.id} />
          <input
            type="text"
            name="title"
            defaultValue={draft.title}
            maxLength={200}
            aria-label="Draft title"
            className="min-w-64 flex-1 rounded border border-transparent bg-transparent px-2 py-1 text-2xl font-semibold text-ink transition-colors hover:border-edge focus:border-edge"
          />
          <button
            type="submit"
            className="rounded border border-edge px-2 py-1 font-mono text-xs text-ink-muted transition-colors hover:border-lime hover:text-lime"
          >
            rename
          </button>
        </form>

        <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
          <code className="rounded bg-surface px-2 py-1 text-ink-muted">{url}</code>
          <CopyButton value={url} />
          <a
            href={`/p/${draft.slug}`}
            target="_blank"
            rel="noreferrer"
            className="rounded border border-edge px-2 py-1 text-ink-muted transition-colors hover:border-lime hover:text-lime"
          >
            open ↗
          </a>

          <VisibilityControls
            draftId={draft.id}
            visibility={draft.visibility}
            hasPassword={draft.passwordHash !== null}
          />

          <form action={deleteDraftAction}>
            <input type="hidden" name="draftId" value={draft.id} />
            <DangerButton label="delete draft" confirmLabel="confirm delete" />
          </form>
        </div>
      </section>

      <section
        aria-label="Current version preview"
        className="flex min-h-96 items-center justify-center rounded-md border border-edge bg-surface"
      >
        {draft.kind === "html" ? (
          <iframe
            src={`/p/${encodeURIComponent(draft.slug)}/content`}
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
            title={`Preview of ${draft.title}`}
            className="h-96 w-full rounded-md border-0 bg-white"
          />
        ) : draft.kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/p/${encodeURIComponent(draft.slug)}/content`}
            alt={draft.title}
            className="max-h-[32rem] max-w-full object-contain"
          />
        ) : (
          <video
            src={`/p/${encodeURIComponent(draft.slug)}/content`}
            controls
            playsInline
            preload="metadata"
            className="max-h-[32rem] max-w-full"
          />
        )}
      </section>

      <section className="flex flex-col gap-3" aria-label="View analytics">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="font-mono text-sm text-ink-muted">analytics</h2>
          <p className="font-mono text-xs text-ink-faint">
            your own views are excluded
            {views.viewerBreakdown30d.owner > 0
              ? ` (${views.viewerBreakdown30d.owner} in the last 30 days)`
              : ""}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <StatTile label="views (24h)" value={String(views.last24h)} />
          <StatTile label="views (7d)" value={String(views.last7d)} />
          <StatTile label="views (30d)" value={String(views.last30d)} />
          <StatTile label="views (total)" value={String(views.total)} />
          <StatTile
            label="visitors (30d)"
            value={String(views.visitors30d)}
            detail="daily uniques"
          />
        </div>

        <div className="grid gap-4 rounded-md border border-edge bg-surface p-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <h3 className="font-mono text-xs text-ink-muted">daily views · last 30 days</h3>
            <ViewSparkline days={views.byDay} />
          </div>
          <div className="grid grid-cols-2 gap-4 font-mono text-xs">
            <div className="flex flex-col gap-1.5">
              <h3 className="text-ink-muted">top referrers (30d)</h3>
              {views.topReferrers30d.length === 0 ? (
                <p className="text-ink-faint">direct / none yet</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {views.topReferrers30d.map((referrer) => (
                    <li key={referrer.host} className="flex justify-between gap-2">
                      <span className="truncate text-ink">{referrer.host}</span>
                      <span className="tabular-nums text-ink-muted">{referrer.views}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <h3 className="text-ink-muted">top countries (30d)</h3>
              {views.topCountries30d.length === 0 ? (
                <p className="text-ink-faint">none yet</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {views.topCountries30d.map((entry) => (
                    <li key={entry.country} className="flex justify-between gap-2">
                      <span className="text-ink">{entry.country}</span>
                      <span className="tabular-nums text-ink-muted">{entry.views}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="col-span-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-edge pt-3 text-ink-faint">
              <span>
                anonymous:{" "}
                <span className="tabular-nums text-ink-muted">
                  {views.viewerBreakdown30d.anonymous}
                </span>
              </span>
              <span>
                signed-in:{" "}
                <span className="tabular-nums text-ink-muted">{views.viewerBreakdown30d.user}</span>
              </span>
              <span>
                you:{" "}
                <span className="tabular-nums text-ink-muted">
                  {views.viewerBreakdown30d.owner}
                </span>
              </span>
              <span>(30d)</span>
            </div>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <NewVersionForm draftId={draft.id} kind={draft.kind} />

        <h2 className="font-mono text-sm text-ink-muted">version history</h2>
        <ul className="flex flex-col divide-y divide-edge rounded-md border border-edge bg-surface">
          {versions.map((version) => (
            <li
              key={version.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 font-mono text-xs"
            >
              <span className={version.id === draft.currentVersionId ? "text-lime" : "text-ink"}>
                v{version.versionNumber}
                {version.id === draft.currentVersionId ? " (current)" : ""}
              </span>
              <span className="text-ink-faint">{formatRelativeTime(version.createdAt)}</span>
              <span className="text-ink-faint">
                {formatBytes(version.totalSizeBytes ?? version.sizeBytes)}
                {version.isBundle ? " · HTML + media" : ""}
              </span>
              <span className="text-ink-faint">
                {version.originalFilename ?? version.contentType}
              </span>
              <code title={version.contentSha256} className="text-ink-muted">
                sha256:{shortHash(version.contentSha256)}
              </code>
              <span className="text-ink-faint">{version.source}</span>
              {version.id !== draft.currentVersionId ? (
                <form action={restoreVersionAction} className="ml-auto">
                  <input type="hidden" name="draftId" value={draft.id} />
                  <input type="hidden" name="versionId" value={version.id} />
                  <button
                    type="submit"
                    className="rounded border border-edge px-2 py-1 text-ink-muted transition-colors hover:border-lime hover:text-lime"
                  >
                    restore
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
