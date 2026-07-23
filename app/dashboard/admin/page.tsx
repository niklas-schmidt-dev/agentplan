import Link from "next/link";
import { redirect } from "next/navigation";
import { DangerButton } from "@/components/dashboard/danger-button";
import { DashboardHeader } from "@/components/dashboard/header";
import { getAdminStats, listUsersWithUsage } from "@/lib/admin/service";
import { isAdmin, requireAdmin } from "@/lib/auth/session";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { getSignupsEnabled } from "@/lib/settings/service";
import { deleteUserAction, setSignupsEnabledAction, setUserRoleAction } from "./actions";

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

      <h1 className="font-mono text-sm text-ink-muted">admin</h1>

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
        <form action={setSignupsEnabledAction}>
          <input type="hidden" name="enabled" value={signupsEnabled ? "false" : "true"} />
          <button
            type="submit"
            className="rounded border border-edge px-3 py-1.5 font-mono text-xs text-ink-muted transition-colors hover:border-lime hover:text-lime"
          >
            {signupsEnabled ? "disable sign-ups" : "enable sign-ups"}
          </button>
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-sm text-ink-muted">users</h2>
        <ul className="flex flex-col divide-y divide-edge rounded-md border border-edge bg-surface">
          {userRows.map((user) => {
            const isSelf = user.id === admin.id;
            return (
              <li
                key={user.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 font-mono text-xs"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">
                    {user.email}
                    {isSelf ? <span className="text-ink-faint"> (you)</span> : null}
                  </p>
                  <p className="text-ink-faint">
                    <span className={user.role === "admin" ? "text-lime" : ""}>{user.role}</span>
                    {" · "}
                    {user.plan}
                    {" · "}
                    {user.draftCount} draft{user.draftCount === 1 ? "" : "s"}
                    {" · "}
                    {formatBytes(user.storageBytes)}
                    {" · "}
                    {user.tokenCount} token{user.tokenCount === 1 ? "" : "s"}
                    {" · joined "}
                    {formatRelativeTime(user.createdAt)}
                  </p>
                </div>
                {!isSelf ? (
                  <div className="flex items-center gap-2">
                    <form action={setUserRoleAction}>
                      <input type="hidden" name="userId" value={user.id} />
                      <input
                        type="hidden"
                        name="role"
                        value={user.role === "admin" ? "user" : "admin"}
                      />
                      <button
                        type="submit"
                        className="rounded border border-edge px-2 py-1 text-ink-muted transition-colors hover:border-lime hover:text-lime"
                      >
                        {user.role === "admin" ? "remove admin" : "make admin"}
                      </button>
                    </form>
                    <form action={deleteUserAction}>
                      <input type="hidden" name="userId" value={user.id} />
                      <DangerButton label="delete" confirmLabel="delete user + data" />
                    </form>
                  </div>
                ) : null}
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
