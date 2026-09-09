import { ShareLink } from "@/components/dashboard/share-link";
import { notFound } from "next/navigation";
import { deleteDraftAction, renameDraftAction } from "@/app/dashboard/actions";
import { RestoreVersionForm } from "@/components/dashboard/restore-version-form";
import { CopyButton } from "@/components/dashboard/copy-button";
import { DangerButton } from "@/components/dashboard/danger-button";
import { DashboardHeader } from "@/components/dashboard/header";
import { Suspense } from "react";
import { DraftAnalytics } from "@/components/dashboard/draft-analytics";
import { UpgradePrompt } from "@/components/dashboard/upgrade-prompt";
import { NewVersionForm } from "@/components/dashboard/upload-form";
import { VisibilityControls } from "@/components/dashboard/visibility-controls";
import { getDraftForOwner, listVersions } from "@/db/queries/drafts";
import { isAdmin, requireUser } from "@/lib/auth/session";
import { isBillingConfigured } from "@/lib/billing/config";
import { limitsForEffectivePlan } from "@/lib/billing/plan";
import { getEffectivePlanForUser } from "@/lib/billing/service";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { draftUrl, draftVersionPath, draftVersionUrl } from "@/lib/urls";
import { uuidSchema } from "@/lib/validation/api";

export const metadata = { title: "Draft" };

export default async function DraftDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ version?: string }>;
}) {
  const user = await requireUser();
  const rawId = uuidSchema.safeParse((await params).id);
  if (!rawId.success) notFound();
  const draft = await getDraftForOwner(rawId.data, user.id);
  if (!draft) notFound();
  const [versions, effective] = await Promise.all([
    listVersions(draft.id),
    getEffectivePlanForUser(user.id),
  ]);
  const billingEnabled = isBillingConfigured();
  const upgradeHref =
    billingEnabled && effective.plan === "free" ? "/dashboard/billing" : undefined;
  const versionCap = limitsForEffectivePlan(effective).keepVersionsByKind[draft.kind];
  const atVersionCap = versionCap !== null && versions.length >= versionCap;
  const capLabel = versionCap === 1 ? "one version" : `${versionCap} versions`;
  const { version: requestedVersion } = await searchParams;
  const selectedVersion = versions.find(
    (version) => version.id === (requestedVersion ?? draft.currentVersionId),
  );
  if (requestedVersion !== undefined && !selectedVersion) notFound();
  const url = draftUrl(draft.slug);
  const previewUrl = `/p/${encodeURIComponent(draft.slug)}/content?version=${encodeURIComponent(selectedVersion?.id ?? "")}`;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 px-6 py-8">
      <DashboardHeader email={user.email} isAdmin={isAdmin(user)} billingEnabled={billingEnabled} />

      <section className="flex flex-col gap-4">
        <form action={renameDraftAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="draftId" value={draft.id} />
          <input
            type="text"
            name="title"
            defaultValue={draft.title}
            maxLength={200}
            aria-label="Draft title"
            className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-2 py-1 text-2xl font-semibold text-ink transition-colors hover:border-edge focus:border-edge"
          />
          <button
            type="submit"
            className="rounded border border-edge px-2 py-1 font-mono text-xs text-ink-muted transition-colors hover:border-lime hover:text-lime"
          >
            rename
          </button>
        </form>

        <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-xs">
          <ShareLink
            key={draft.slug}
            currentUrl={url}
            selected={requestedVersion ?? "current"}
            versions={versions.map((version) => ({
              id: version.id,
              number: version.versionNumber,
              url: draftVersionUrl(draft.slug, version.id),
            }))}
          />

          <VisibilityControls
            draftId={draft.id}
            visibility={draft.visibility}
            hasPassword={draft.passwordHash !== null}
          />
        </div>
      </section>

      <section
        aria-label="Selected version preview"
        className="flex min-h-96 items-center justify-center rounded-md border border-edge bg-surface"
      >
        {!selectedVersion ? (
          <p className="text-ink-muted">No published version yet.</p>
        ) : draft.kind === "html" ? (
          <iframe
            key={selectedVersion.id}
            src={previewUrl}
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
            title={`Preview of ${draft.title}`}
            className="h-96 w-full rounded-md border-0 bg-white"
          />
        ) : draft.kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt={draft.title}
            className="max-h-[32rem] max-w-full object-contain"
          />
        ) : (
          <video
            key={selectedVersion.id}
            src={previewUrl}
            controls
            playsInline
            preload="metadata"
            className="max-h-[32rem] max-w-full"
          />
        )}
      </section>

      <Suspense
        key={selectedVersion?.id ?? "empty"}
        fallback={
          <p role="status" className="font-mono text-xs text-ink-faint">
            Loading analytics…
          </p>
        }
      >
        <DraftAnalytics
          draftId={draft.id}
          versionId={selectedVersion?.id}
          versionNumber={selectedVersion?.versionNumber}
        />
      </Suspense>

      <section className="flex flex-col gap-3">
        {!atVersionCap ? (
          <NewVersionForm draftId={draft.id} kind={draft.kind} upgradeHref={upgradeHref} />
        ) : upgradeHref ? (
          <UpgradePrompt
            title="Version history is a Pro feature"
            message={`Free keeps ${capLabel} per draft. This link keeps working. Pro lets you add, pin, and restore versions without a cap.`}
            href={upgradeHref}
            alternative="or upload the new file as a separate draft"
          />
        ) : (
          <p className="font-mono text-xs text-ink-faint">
            This plan keeps {capLabel} per draft. Upload the new file as a separate draft.
          </p>
        )}

        <h2 className="font-mono text-sm text-ink-muted">version history</h2>
        <ul className="flex flex-col divide-y divide-edge rounded-md border border-edge bg-surface">
          {versions.map((version) => (
            <li
              key={version.id}
              aria-current={version.id === selectedVersion?.id ? "true" : undefined}
              className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 font-mono text-xs ${version.id === selectedVersion?.id ? "bg-lime/5" : ""}`}
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
              <details className="min-w-0 text-ink-faint">
                <summary className="cursor-pointer hover:text-ink-muted">file details</summary>
                <dl className="mt-2 flex flex-col gap-1 break-all">
                  <div>
                    <dt className="sr-only">Filename</dt>
                    <dd>{version.originalFilename ?? version.contentType}</dd>
                  </div>
                  <div>
                    <dt className="sr-only">Source</dt>
                    <dd>{version.source}</dd>
                  </div>
                  <div>
                    <dt>SHA-256</dt>
                    <dd>{version.contentSha256}</dd>
                  </div>
                </dl>
              </details>
              <div className="ml-auto flex flex-wrap items-start gap-2">
                <a
                  href={draftVersionPath(draft.slug, version.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded border border-edge px-2 py-1 text-ink-muted transition-colors hover:border-lime hover:text-lime"
                >
                  view ↗
                </a>
                <CopyButton
                  value={draftVersionUrl(draft.slug, version.id)}
                  label="copy version link"
                />
                {version.id !== draft.currentVersionId ? (
                  <RestoreVersionForm
                    draftId={draft.id}
                    versionId={version.id}
                    upgradeHref={upgradeHref}
                  />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <footer className="flex justify-end border-t border-edge pt-4">
        <form action={deleteDraftAction}>
          <input type="hidden" name="draftId" value={draft.id} />
          <DangerButton label="delete draft" confirmLabel="confirm delete" />
        </form>
      </footer>
    </main>
  );
}
