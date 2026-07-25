import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminUnblockButton } from "@/components/dashboard/admin-unblock-button";
import { DashboardHeader } from "@/components/dashboard/header";
import { listIdentityBlocks } from "@/lib/admin/service";
import { isAdmin, requireAdmin } from "@/lib/auth/session";
import { formatRelativeTime } from "@/lib/format";

export const metadata = { title: "Blocked identities" };
const BLOCKS_PER_PAGE = 50;

function blocksHref({ page, search }: { page?: number; search?: string }): string {
  const query = new URLSearchParams();
  if (page && page > 1) query.set("page", String(page));
  if (search) query.set("q", search);
  const suffix = query.toString();
  return `/dashboard/admin/blocks${suffix ? `?${suffix}` : ""}`;
}

export default async function AdminBlocksPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const admin = await requireAdmin();
  const params = await searchParams;
  const parsedPage = Number.parseInt(params.page ?? "1", 10);
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const search = params.q?.trim().slice(0, 200) || undefined;
  const result = await listIdentityBlocks({
    search,
    limit: BLOCKS_PER_PAGE,
    offset: (page - 1) * BLOCKS_PER_PAGE,
  });
  const totalPages = Math.max(1, Math.ceil(result.total / BLOCKS_PER_PAGE));
  if (page > totalPages) redirect(blocksHref({ page: totalPages, search }));

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 px-6 py-8">
      <DashboardHeader email={admin.email} isAdmin={isAdmin(admin)} />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-mono text-sm text-ink-muted">
            <Link href="/dashboard/admin" className="transition-colors hover:text-lime">
              admin
            </Link>
            {" / blocked identities"}
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-ink-faint">
            Blocks retain the normalized email and known OAuth identities until manually removed.
            Unblocking restores retained uploads immediately but does not recreate sessions or API
            tokens.
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
        <label className="min-w-64 flex-1">
          <span className="sr-only">Search identity blocks</span>
          <input
            type="search"
            name="q"
            defaultValue={search ?? ""}
            placeholder="search email or internal reason…"
            className="w-full rounded border border-edge bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint"
          />
        </label>
        <button
          type="submit"
          className="rounded border border-edge px-3 py-2 text-ink-muted transition-colors hover:border-lime hover:text-lime"
        >
          search
        </button>
        {search ? (
          <Link
            href="/dashboard/admin/blocks"
            className="rounded px-2 py-2 text-ink-faint transition-colors hover:text-ink"
          >
            clear
          </Link>
        ) : null}
      </form>

      {result.blocks.length === 0 ? (
        <div className="rounded-md border border-dashed border-edge px-4 py-10 text-center">
          <p className="font-mono text-sm text-ink-faint">
            No blocked identities{search ? " match this search" : ""}.
          </p>
        </div>
      ) : (
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-mono text-sm text-ink-muted">denylist</h2>
            <span className="font-mono text-xs text-ink-faint">
              {result.total} block{result.total === 1 ? "" : "s"}
            </span>
          </div>
          <ul className="flex flex-col divide-y divide-edge rounded-md border border-edge bg-surface">
            {result.blocks.map((block) => (
              <li
                key={block.id}
                className="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 py-4 font-mono text-xs"
              >
                <div className="min-w-72 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm text-ink">{block.normalizedEmail}</p>
                    <span className="rounded-sm border border-danger/50 bg-danger/10 px-1.5 py-0.5 text-danger">
                      blocked
                    </span>
                    <span className="rounded-sm border border-edge px-1.5 py-0.5 text-ink-muted">
                      {block.accountRetained ? "account retained" : "account deleted"}
                    </span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-ink-muted">{block.reason}</p>
                  <p className="mt-2 text-ink-faint" title={block.createdAt.toISOString()}>
                    blocked {formatRelativeTime(block.createdAt)}
                    {" · "}
                    {block.oauthIdentityCount} OAuth identit
                    {block.oauthIdentityCount === 1 ? "y" : "ies"} retained
                  </p>
                </div>
                <AdminUnblockButton blockId={block.id} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {totalPages > 1 ? (
        <nav
          aria-label="Identity block pagination"
          className="flex items-center justify-between font-mono text-xs text-ink-muted"
        >
          {page > 1 ? (
            <Link
              className="transition-colors hover:text-lime"
              href={blocksHref({ page: page - 1, search })}
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
              href={blocksHref({ page: page + 1, search })}
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
