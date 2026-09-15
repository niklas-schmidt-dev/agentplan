import { InvalidGroupCursorError } from "@/lib/api/group-cursor";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DashboardHeader } from "@/components/dashboard/header";
import { GroupCards } from "@/components/dashboard/group-cards";
import { NewGroupButton } from "@/components/dashboard/group-controls";
import { GroupNavigation } from "@/components/dashboard/group-navigation";
import { listGroupsPageForOwner } from "@/db/queries/groups";
import { isAdmin, requireUser } from "@/lib/auth/session";
import { isBillingConfigured } from "@/lib/billing/config";

export const metadata = { title: "Groups" };

export default async function GroupsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; groupsCursor?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const search = params.q?.trim() || undefined;
  const [page, roots] = await Promise.all([
    listGroupsPageForOwner(user.id, {
      scope: search ? "subtree" : "children",
      search,
      limit: 24,
      cursor: params.groupsCursor,
    }),
    listGroupsPageForOwner(user.id, { limit: 30 }),
  ]).catch((error: unknown) => {
    if (error instanceof InvalidGroupCursorError)
      redirect(`/dashboard/groups${search ? `?q=${encodeURIComponent(search)}` : ""}`);
    throw error;
  });
  const pageUrl = (cursor?: string | null) => {
    const query = new URLSearchParams();
    if (search) query.set("q", search);
    if (cursor) query.set("groupsCursor", cursor);
    return `/dashboard/groups?${query}`;
  };
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-7xl flex-col gap-6 px-6 py-8">
      <DashboardHeader
        email={user.email}
        isAdmin={isAdmin(user)}
        billingEnabled={isBillingConfigured()}
      />
      <div className="flex min-w-0 flex-col gap-6 lg:flex-row">
        <GroupNavigation key={JSON.stringify(roots)} roots={roots} overview />
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <section className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">Groups</h1>
              <p className="mt-2 text-sm text-ink-muted">
                Organize by client, project, topic, or whatever fits. Nest groups as you need.
              </p>
            </div>
            <NewGroupButton />
          </section>
          <form method="GET" className="flex gap-3">
            <label className="min-w-0 flex-1">
              <span className="sr-only">Search groups</span>
              <input
                type="search"
                name="q"
                defaultValue={search ?? ""}
                placeholder="Search groups at every level…"
                className="w-full rounded border border-edge bg-surface px-3 py-2 font-mono text-sm text-ink"
              />
            </label>
            <button
              type="submit"
              className="rounded border border-edge px-3 py-2 font-mono text-xs text-ink-muted hover:border-lime hover:text-lime"
            >
              Search
            </button>
          </form>
          {page.groups.length ? (
            <GroupCards groups={page.groups} />
          ) : (
            <section className="rounded-md border border-dashed border-edge p-8">
              <h2 className="text-lg text-ink">
                {search ? "No matching groups" : "Make room for your next project"}
              </h2>
              <p className="mt-2 max-w-lg text-sm leading-relaxed text-ink-muted">
                {search
                  ? "Try another group name."
                  : "Create your first group, then add files and subgroups. Existing files stay in Ungrouped until you move them."}
              </p>
              {!search ? (
                <div className="mt-4">
                  <NewGroupButton />
                </div>
              ) : null}
            </section>
          )}
          {params.groupsCursor || page.nextCursor ? (
            <nav aria-label="Group pages" className="flex gap-4 font-mono text-sm text-lime">
              {params.groupsCursor ? <Link href={pageUrl()}>First page</Link> : null}
              {page.nextCursor ? <Link href={pageUrl(page.nextCursor)}>More groups →</Link> : null}
            </nav>
          ) : null}
        </div>
      </div>
    </main>
  );
}
