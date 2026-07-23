import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminUserActions } from "@/components/dashboard/admin-user-actions";
import { DashboardHeader } from "@/components/dashboard/header";
import { SignupToggleForm } from "@/components/dashboard/signup-toggle-form";
import { getAdminStats, listUsersWithUsage } from "@/lib/admin/service";
import { isAdmin, requireAdmin } from "@/lib/auth/session";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { limitsForPlan } from "@/lib/limits/plans";
import { getSignupsEnabled } from "@/lib/settings/service";

export const metadata = { title: "Admin" };
const USERS_PER_PAGE = 50;

function StatTile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-edge bg-surface p-4">
      <span className="font-mono text-xs text-ink-muted">{label}</span>
      <span className="text-2xl font-semibold text-ink">{value}</span>
      {detail ? <span className="font-mono text-xs text-ink-faint">{detail}</span> : null}
    </div>
  );
}

function UsageMeter({
  label,
  used,
  limit,
  format = String,
}: {
  label: string;
  used: number;
  limit: number | null;
  format?: (value: number) => string;
}) {
  const percentage = limit === null ? null : Math.min((used / limit) * 100, 100);
  const nearLimit = percentage !== null && percentage >= 90;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-ink-faint">{label}</span>
        <span className="whitespace-nowrap text-ink">
          {format(used)}
          <span className={limit === null ? "text-lime" : "text-ink-faint"}>
            {" / "}
            {limit === null ? "unlimited" : format(limit)}
          </span>
        </span>
      </div>
      {percentage === null ? (
        <div aria-hidden="true" className="h-px border-t border-dashed border-lime/40" />
      ) : (
        <div
          role="progressbar"
          aria-label={`${label} quota usage`}
          aria-valuemin={0}
          aria-valuemax={limit ?? undefined}
          aria-valuenow={used}
          className="h-1 overflow-hidden rounded-full bg-edge"
        >
          <div
            className={`h-full rounded-full transition-[width] ${
              nearLimit ? "bg-danger" : "bg-lime"
            }`}
            style={{ width: `${percentage}%` }}
          />
        </div>
      )}
    </div>
  );
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const admin = await requireAdmin();
  const { page: pageParam } = await searchParams;
  const parsedPage = Number.parseInt(pageParam ?? "1", 10);
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const [stats, userRows, signupsEnabled] = await Promise.all([
    getAdminStats(),
    listUsersWithUsage({
      limit: USERS_PER_PAGE,
      offset: (page - 1) * USERS_PER_PAGE,
    }),
    getSignupsEnabled(),
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
        <Link
          href="/dashboard/admin/content"
          className="rounded border border-edge px-3 py-1.5 font-mono text-xs text-ink-muted transition-colors hover:border-lime hover:text-lime"
        >
          moderate content →
        </Link>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="users" value={String(stats.users)} />
        <StatTile label="drafts" value={String(stats.liveDrafts)} />
        <StatTile
          label="versions"
          value={String(stats.versions)}
          detail={formatBytes(stats.storageBytes)}
        />
        <StatTile label="active tokens" value={String(stats.activeTokens)} />
      </section>

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
        <h2 className="font-mono text-sm text-ink-muted">users</h2>
        <ul className="flex flex-col divide-y divide-edge rounded-md border border-edge bg-surface">
          {userRows.map((user) => {
            const isSelf = user.id === admin.id;
            const limits = limitsForPlan(user.plan);
            return (
              <li
                key={user.id}
                className="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 py-4 font-mono text-xs"
              >
                <div className="min-w-72 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm text-ink">
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
                    <span className="text-ink-faint">
                      joined {formatRelativeTime(user.createdAt)}
                    </span>
                  </div>

                  <div className="mt-3 grid gap-x-5 gap-y-3 rounded border border-edge/70 bg-canvas/40 px-3 py-2.5 sm:grid-cols-3">
                    <UsageMeter label="drafts" used={user.draftCount} limit={limits.maxDrafts} />
                    <UsageMeter
                      label="storage"
                      used={user.storageBytes}
                      limit={limits.maxStorageBytes}
                      format={formatBytes}
                    />
                    <UsageMeter
                      label="tokens"
                      used={user.tokenCount}
                      limit={limits.maxActiveTokens}
                    />
                  </div>
                </div>
                {user.draftCount > 0 ? (
                  <Link
                    href={`/dashboard/admin/content?owner=${encodeURIComponent(user.id)}`}
                    className="rounded border border-edge px-2 py-1 text-ink-muted transition-colors hover:border-lime hover:text-lime"
                  >
                    uploads
                  </Link>
                ) : null}
                <AdminUserActions
                  userId={user.id}
                  plan={user.plan}
                  role={user.role}
                  isSelf={isSelf}
                />
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
              <Link
                className="transition-colors hover:text-lime"
                href={`/dashboard/admin?page=${page - 1}`}
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
                href={`/dashboard/admin?page=${page + 1}`}
              >
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
