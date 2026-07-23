import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminDraftActions } from "@/components/dashboard/admin-draft-actions";
import { DashboardHeader } from "@/components/dashboard/header";
import { listDraftsForAdmin } from "@/lib/admin/service";
import { isAdmin, requireAdmin } from "@/lib/auth/session";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { deletedDraftRetentionDays } from "@/lib/limits/plans";

export const metadata = { title: "Content moderation" };
const DRAFTS_PER_PAGE = 50;

function contentHref({
  page,
  search,
  owner,
}: {
  page?: number;
  search?: string;
  owner?: string;
}): string {
  const query = new URLSearchParams();
  if (page && page > 1) query.set("page", String(page));
  if (search) query.set("q", search);
  if (owner) query.set("owner", owner);
  const suffix = query.toString();
  return `/dashboard/admin/content${suffix ? `?${suffix}` : ""}`;
}

export default async function AdminContentPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string; owner?: string }>;
}) {
  const admin = await requireAdmin();
  const params = await searchParams;
  const parsedPage = Number.parseInt(params.page ?? "1", 10);
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const search = params.q?.trim().slice(0, 200) || undefined;
  const owner = params.owner?.trim().slice(0, 255) || undefined;
  const result = await listDraftsForAdmin({
    search,
    ownerId: owner,
    limit: DRAFTS_PER_PAGE,
    offset: (page - 1) * DRAFTS_PER_PAGE,
  });
  const totalPages = Math.max(1, Math.ceil(result.total / DRAFTS_PER_PAGE));
  if (page > totalPages) {
    redirect(contentHref({ page: totalPages, search, owner }));
  }
  const retentionDays = deletedDraftRetentionDays();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 px-6 py-8">
      <DashboardHeader email={admin.email} isAdmin={isAdmin(admin)} />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-mono text-sm text-ink-muted">
            <Link href="/dashboard/admin" className="transition-colors hover:text-lime">
              admin
            </Link>
            {" / content"}
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-ink-faint">
            Removing an upload makes its link inaccessible immediately. Stored versions are
            permanently purged after {retentionDays} day{retentionDays === 1 ? "" : "s"}.
          </p>
        </div>
        <Link
          href="/dashboard/admin"
          className="rounded border border-edge px-3 py-1.5 font-mono text-xs text-ink-muted transition-colors hover:border-lime hover:text-lime"
        >
          ← users
        </Link>
      </div>

      <form method="GET" className="flex flex-wrap items-center gap-2 font-mono text-xs">
        {owner ? <input type="hidden" name="owner" value={owner} /> : null}
        <label className="min-w-64 flex-1">
          <span className="sr-only">Search uploads</span>
          <input
            type="search"
            name="q"
            defaultValue={search ?? ""}
            placeholder="search title, slug, or owner email…"
            className="w-full rounded border border-edge bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint"
          />
        </label>
        <button
          type="submit"
          className="rounded border border-edge px-3 py-2 text-ink-muted transition-colors hover:border-lime hover:text-lime"
        >
          search
        </button>
        {search || owner ? (
          <Link
            href="/dashboard/admin/content"
            className="rounded px-2 py-2 text-ink-faint transition-colors hover:text-ink"
          >
            clear filters
          </Link>
        ) : null}
      </form>

      {owner ? (
        <p className="font-mono text-xs text-ink-muted">
          showing uploads for{" "}
          <span className="text-ink">{result.drafts[0]?.ownerEmail ?? owner}</span>
        </p>
      ) : null}

      {result.drafts.length === 0 ? (
        <div className="rounded-md border border-dashed border-edge px-4 py-10 text-center">
          <p className="font-mono text-sm text-ink-faint">
            No live uploads{search || owner ? " match these filters" : " yet"}.
          </p>
        </div>
      ) : (
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-mono text-sm text-ink-muted">live uploads</h2>
            <span className="font-mono text-xs text-ink-faint">
              {result.total} result{result.total === 1 ? "" : "s"}
            </span>
          </div>
          <ul className="flex flex-col divide-y divide-edge rounded-md border border-edge bg-surface">
            {result.drafts.map((draft) => (
              <li key={draft.id} className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{draft.title}</p>
                  <p className="truncate font-mono text-xs text-ink-faint">
                    <span className={draft.visibility === "public" ? "text-lime" : ""}>
                      {draft.visibility}
                    </span>
                    {" · "}
                    {draft.currentVersion
                      ? `v${draft.currentVersion.versionNumber} · ${formatBytes(
                          draft.currentVersion.sizeBytes,
                        )}`
                      : "no version"}
                    {" · "}
                    {draft.ownerEmail}
                    {" · updated "}
                    {formatRelativeTime(draft.updatedAt)}
                  </p>
                  <code className="block truncate pt-1 font-mono text-xs text-ink-muted">
                    /p/{draft.slug}
                  </code>
                </div>
                <div className="flex items-center gap-2">
                  {draft.visibility === "public" ? (
                    <a
                      href={`/p/${encodeURIComponent(draft.slug)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded border border-edge px-2 py-1 font-mono text-xs text-ink-muted transition-colors hover:border-lime hover:text-lime"
                    >
                      inspect ↗
                    </a>
                  ) : null}
                  <AdminDraftActions draftId={draft.id} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {totalPages > 1 ? (
        <nav
          aria-label="Content pagination"
          className="flex items-center justify-between font-mono text-xs text-ink-muted"
        >
          {page > 1 ? (
            <Link
              className="transition-colors hover:text-lime"
              href={contentHref({ page: page - 1, search, owner })}
            >
              ← previous
            </Link>
          ) : (
            <span />
          )}
          <span>
            page {page} / {totalPages}
          </span>
          {page < totalPages ? (
            <Link
              className="transition-colors hover:text-lime"
              href={contentHref({ page: page + 1, search, owner })}
            >
              next →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </main>
  );
}
