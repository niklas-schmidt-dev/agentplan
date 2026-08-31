import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminUserActions } from "@/components/dashboard/admin-user-actions";
import { DashboardHeader } from "@/components/dashboard/header";
import { SignupToggleForm } from "@/components/dashboard/signup-toggle-form";
import { StatTile } from "@/components/dashboard/stat-tile";
import { UsageMeter } from "@/components/dashboard/usage-meter";
import { getAdminStats, listUsersWithUsage } from "@/lib/admin/service";
import { getAdminViewStats, getTopDraftsByViews } from "@/lib/analytics/queries";
import { isAdmin, requireAdmin } from "@/lib/auth/session";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { limitsForPlan } from "@/lib/limits/plans";
import { getSignupsEnabled } from "@/lib/settings/service";

export const metadata = { title: "Admin" };
const USERS_PER_PAGE = 50;

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const admin = await requireAdmin();
  const { page: pageParam } = await searchParams;
  const parsedPage = Number.parseInt(pageParam ?? "1", 10);
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const [stats, userRows, signupsEnabled, viewStats, topDrafts] = await Promise.all([
    getAdminStats(),
    listUsersWithUsage({
      limit: USERS_PER_PAGE,
      offset: (page - 1) * USERS_PER_PAGE,
    }),
    getSignupsEnabled(),
    getAdminViewStats(),
    getTopDraftsByViews({ days: 7, limit: 5 }),
  ]);
  const totalPages = Math.max(1, Math.ceil(stats.users / USERS_PER_PAGE));
  if (page > totalPages) {
    redirect(`/dashboard/admin?page=${totalPages}`);
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 px-6 py-8">
      <DashboardHeader email={admin.email} isAdmin={isAdmin(admin)} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-mono text-sm text-ink-muted">admin / users</h1>
        <div className="flex items-center gap-2">
          <Link
            href="/dashboard/admin/blocks"
            className="rounded border border-edge px-3 py-1.5 font-mono text-xs text-ink-muted hover:border-lime hover:text-lime"
          >
            blocked identities →
          </Link>
          <Link
            href="/dashboard/admin/content"
            className="rounded border border-edge px-3 py-1.5 font-mono text-xs text-ink-muted hover:border-lime hover:text-lime"
          >
            moderate content →
          </Link>
        </div>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="users" value={String(stats.users)} />
        <StatTile label="blocks" value={String(stats.blockedUsers)} />
        <StatTile label="drafts" value={String(stats.liveDrafts)} />
        <StatTile
          label="versions"
          value={String(stats.versions)}
          detail={formatBytes(stats.storageBytes)}
        />
        <StatTile label="active tokens" value={String(stats.activeTokens)} />
        <StatTile
          label="views (7d)"
          value={String(viewStats.last7d)}
          detail={`${viewStats.total} total`}
        />
      </section>

      {topDrafts.length > 0 ? (
        <section className="flex flex-col gap-2 rounded-md border border-edge bg-surface p-4">
          <h2 className="font-mono text-xs text-ink-muted">
            most viewed drafts (7d, owner views excluded)
          </h2>
          <ul role="list" className="flex flex-col gap-1.5 font-mono text-xs">
            {topDrafts.map((draft) => (
              <li key={draft.draftId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="w-12 shrink-0 tabular-nums text-lime">{draft.views}</span>
                <a
                  href={`/p/${draft.slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="max-w-64 truncate text-ink hover:text-lime"
                >
                  {draft.title}
                </a>
                <span className="text-ink-faint">{draft.visibility}</span>
                <span className="truncate text-ink-faint">{draft.ownerEmail}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-edge bg-surface p-4">
        <div>
          <p className="font-mono text-sm text-ink">
            sign-ups are{" "}
            <span className={signupsEnabled ? "text-lime" : "text-danger"}>
              {signupsEnabled ? "enabled" : "disabled"}
            </span>
          </p>
          <p className="font-mono text-xs text-ink-faint">
            When disabled, no new accounts can be created — via email or GitHub.
          </p>
        </div>
        <SignupToggleForm enabled={signupsEnabled} />
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="font-mono text-sm text-ink-muted">users</h2>
          <p className="mt-1 max-w-3xl text-xs text-ink-faint">
            Block keeps uploads and identity data but revokes access. Delete allows registration
            again. Delete + block removes account data while retaining known email and OAuth
            identities.
          </p>
        </div>
        <ul
          role="list"
          className="flex flex-col divide-y divide-edge rounded-md border border-edge bg-surface"
        >
          {userRows.map((user) => {
            const isSelf = user.id === admin.id;
            const limits = limitsForPlan(user.plan);
            return (
              <li key={user.id} className="flex flex-col gap-3 p-4 font-mono text-xs">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  <p className="max-w-full truncate text-sm text-ink">
                    {user.email}
                    {isSelf ? <span className="text-ink-faint"> (you)</span> : null}
                  </p>
                  <span
                    className={`rounded-sm border px-1.5 py-0.5 ${
                      user.plan === "unlimited"
                        ? "border-lime/40 bg-lime/5 text-lime"
                        : "border-edge text-ink-muted"
                    }`}
                  >
                    {user.plan}
                  </span>
                  {user.role === "admin" ? (
                    <span className="rounded-sm border border-lime/40 px-1.5 py-0.5 text-lime">
                      admin
                    </span>
                  ) : null}
                  {user.blockedAt ? (
                    <span className="rounded-sm border border-danger/50 bg-danger/10 px-1.5 py-0.5 text-danger">
                      blocked
                    </span>
                  ) : null}
                  <span className="text-ink-faint">
                    joined {formatRelativeTime(user.createdAt)}
                  </span>
                  <span className="text-ink-faint">
                    {user.views30d} {user.views30d === 1 ? "view" : "views"} (30d)
                  </span>
                </div>

                <div className="@container">
                  <div className="grid grid-cols-1 gap-x-6 gap-y-3 rounded border border-edge/70 bg-canvas/40 p-3 @md:grid-cols-3">
                    <UsageMeter label="drafts" used={user.draftCount} limit={limits.maxDrafts} />
                    <UsageMeter
                      label="storage"
                      used={user.storageBytes + user.reservedBytes}
                      limit={limits.maxStorageBytes}
                      format={formatBytes}
                      detail={
                        user.reservedBytes > 0
                          ? `${formatBytes(user.storageBytes)} committed + ${formatBytes(user.reservedBytes)} reserved`
                          : undefined
                      }
                    />
                    <UsageMeter
                      label="tokens"
                      used={user.tokenCount}
                      limit={limits.maxActiveTokens}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-start justify-between gap-2">
                  {user.draftCount > 0 ? (
                    <Link
                      href={`/dashboard/admin/content?owner=${encodeURIComponent(user.id)}`}
                      className="rounded border border-edge px-2 py-1 text-ink-muted hover:border-lime hover:text-lime"
                    >
                      view uploads →
                    </Link>
                  ) : (
                    <span />
                  )}
                  <AdminUserActions
                    userId={user.id}
                    plan={user.plan}
                    role={user.role}
                    isSelf={isSelf}
                    blockedAt={user.blockedAt}
                    blockId={user.blockId}
                    blockReason={user.blockReason}
                  />
                </div>
              </li>
            );
          })}
        </ul>
        {totalPages > 1 ? (
          <nav
            aria-label="User list pagination"
            className="flex items-center justify-between font-mono text-xs text-ink-muted"
          >
            {page > 1 ? (
              <Link className="hover:text-lime" href={`/dashboard/admin?page=${page - 1}`}>
                ← previous
              </Link>
            ) : (
              <span />
            )}
            <span>
              page {page} / {totalPages}
            </span>
            {page < totalPages ? (
              <Link className="hover:text-lime" href={`/dashboard/admin?page=${page + 1}`}>
                next →
              </Link>
            ) : (
              <span />
            )}
          </nav>
        ) : null}
      </section>
    </main>
  );
}
