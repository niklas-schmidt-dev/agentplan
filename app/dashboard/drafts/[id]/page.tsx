import { notFound } from "next/navigation";
import { deleteDraftAction, renameDraftAction, restoreVersionAction } from "@/app/dashboard/actions";
import { CopyButton } from "@/components/dashboard/copy-button";
import { DangerButton } from "@/components/dashboard/danger-button";
import { DashboardHeader } from "@/components/dashboard/header";
import { NewVersionForm } from "@/components/dashboard/upload-form";
import { VisibilityControls } from "@/components/dashboard/visibility-controls";
import { getDraftForOwner, listVersions } from "@/db/queries/drafts";
import { isAdmin, requireUser } from "@/lib/auth/session";
import { formatBytes, formatRelativeTime, shortHash } from "@/lib/format";
import { draftUrl } from "@/lib/urls";
import { uuidSchema } from "@/lib/validation/api";

export const metadata = { title: "Draft" };

export default async function DraftDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const rawId = uuidSchema.safeParse((await params).id);
  if (!rawId.success) notFound();
  const draft = await getDraftForOwner(rawId.data, user.id);
  if (!draft) notFound();
  const versions = await listVersions(draft.id);
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

      <section aria-label="Current version preview" className="rounded-md border border-edge">
        <iframe
          src={`/p/${encodeURIComponent(draft.slug)}/content`}
          sandbox="allow-scripts allow-forms allow-modals allow-popups"
          title={`Preview of ${draft.title}`}
          className="h-96 w-full rounded-md border-0 bg-white"
        />
      </section>

      <section className="flex flex-col gap-3">
        <NewVersionForm draftId={draft.id} />

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
              <span className="text-ink-faint">{formatBytes(version.sizeBytes)}</span>
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
