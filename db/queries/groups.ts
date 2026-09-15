import { and, desc, eq, ilike, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { groups, users, type Group } from "@/db/schema";
import { assertGroupForOwner, groupSubtreeQuery, type GroupReader } from "@/lib/groups/access";
import { InvalidGroupError } from "@/lib/groups/errors";
import { decodeGroupCursor, encodeGroupCursor, groupFilterKey } from "@/lib/api/group-cursor";

export type GroupPath = Array<{ id: string; name: string }>;
export type GroupListItem = Group & {
  path: GroupPath;
  directDraftCount: number;
  subtreeDraftCount: number;
  childGroupCount: number;
  pendingUploadCount: number;
};
export type GroupListFilters = {
  parentId?: string | null;
  scope?: "children" | "subtree";
  search?: string;
  limit?: number;
  cursor?: string;
};

async function pathsForGroups(
  db: GroupReader,
  ownerId: string,
  ids: string[],
): Promise<Record<string, GroupPath>> {
  if (!ids.length) return {};
  const result = await db.execute<{
    rootId: string;
    id: string;
    name: string;
    parentId: string | null;
    depth: number;
    cycle: boolean;
  }>(sql`with recursive ancestors as (
    select g.id as root_id, g.id, g.name, g.parent_id, 0 as depth, array[g.id] as visited, false as cycle
    from groups g join users u on u.id = g.owner_id
    where g.owner_id = ${ownerId} and u.blocked_at is null
      and g.id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    union all
    select a.root_id, g.id, g.name, g.parent_id, a.depth + 1, a.visited || g.id, g.id = any(a.visited)
    from ancestors a join groups g on g.id = a.parent_id
    where g.owner_id = ${ownerId} and not a.cycle
  ) select root_id as "rootId", id, name, parent_id as "parentId", depth, cycle
    from ancestors order by depth desc`);
  const paths: Record<string, GroupPath> = {};
  for (const row of result.rows) {
    if (row.cycle) throw new InvalidGroupError("The group hierarchy contains a cycle.");
    if (!paths[row.rootId]) {
      if (row.parentId !== null) throw new InvalidGroupError("The group hierarchy is incomplete.");
      paths[row.rootId] = [];
    }
    paths[row.rootId]!.push({ id: row.id, name: row.name });
  }
  return paths;
}

/** One recursive query for every requested path, never a request per ancestor. */
export async function getGroupPathsForOwner(
  ownerId: string,
  groupIds: string[],
): Promise<Record<string, GroupPath>> {
  const ids = [...new Set(groupIds)];
  if (!ids.length) return {};
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '5s'`);
    return pathsForGroups(tx, ownerId, ids);
  });
}

async function enrichGroups(
  db: GroupReader,
  ownerId: string,
  rows: Group[],
): Promise<GroupListItem[]> {
  if (!rows.length) return [];
  const ids = sql.join(
    rows.map((row) => sql`${row.id}::uuid`),
    sql`, `,
  );
  const counts = await db.execute<{
    id: string;
    directDraftCount: string;
    subtreeDraftCount: string;
    childGroupCount: string;
    pendingUploadCount: string;
    cycle: boolean;
  }>(sql`with recursive tree as (
    select g.id as root_id, g.id, array[g.id] as visited, false as cycle
    from groups g join users u on u.id = g.owner_id
    where g.owner_id = ${ownerId} and u.blocked_at is null and g.id in (${ids})
    union all
    select t.root_id, g.id, t.visited || g.id, g.id = any(t.visited)
    from tree t join groups g on g.parent_id = t.id
    where g.owner_id = ${ownerId} and not t.cycle
  ), draft_counts as (
    select t.root_id, count(d.id) as total,
      count(d.id) filter (where t.id = t.root_id) as direct, bool_or(t.cycle) as cycle
    from tree t left join drafts d on d.group_id = t.id and d.owner_id = ${ownerId}
      and d.deleted_at is null and (d.expires_at is null or d.expires_at > clock_timestamp())
    group by t.root_id
  ), children as (
    select parent_id, count(*) as total from groups
    where owner_id = ${ownerId} and parent_id in (${ids}) group by parent_id
  ), pending as (
    select target_group_id, count(*) as total from upload_intents
    where owner_id = ${ownerId} and target_group_id in (${ids}) and target_draft_id is null
      and status = 'pending' and expires_at > clock_timestamp() group by target_group_id
  ) select d.root_id as id, d.direct as "directDraftCount", d.total as "subtreeDraftCount",
    coalesce(c.total, 0) as "childGroupCount", coalesce(p.total, 0) as "pendingUploadCount", d.cycle
    from draft_counts d left join children c on c.parent_id = d.root_id
    left join pending p on p.target_group_id = d.root_id`);
  const paths = await pathsForGroups(
    db,
    ownerId,
    rows.map((row) => row.id),
  );
  const byId = new Map(counts.rows.map((row) => [row.id, row]));
  return rows.map((group) => {
    const count = byId.get(group.id);
    if (count?.cycle) throw new InvalidGroupError("The group hierarchy contains a cycle.");
    return {
      ...group,
      path: paths[group.id] ?? [],
      directDraftCount: Number(count?.directDraftCount ?? 0),
      subtreeDraftCount: Number(count?.subtreeDraftCount ?? 0),
      childGroupCount: Number(count?.childGroupCount ?? 0),
      pendingUploadCount: Number(count?.pendingUploadCount ?? 0),
    };
  });
}

export async function getGroupForOwner(
  groupId: string,
  ownerId: string,
): Promise<GroupListItem | null> {
  return getDb().transaction(
    async (tx) => {
      await tx.execute(sql`set local statement_timeout = '5s'`);
      const rows = await tx
        .select({ group: groups })
        .from(groups)
        .innerJoin(users, eq(groups.ownerId, users.id))
        .where(and(eq(groups.id, groupId), eq(groups.ownerId, ownerId), isNull(users.blockedAt)))
        .limit(1);
      return (
        (
          await enrichGroups(
            tx,
            ownerId,
            rows.map((row) => row.group),
          )
        )[0] ?? null
      );
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function listGroupsPageForOwner(
  ownerId: string,
  filters: GroupListFilters = {},
): Promise<{ groups: GroupListItem[]; nextCursor: string | null }> {
  const filter = groupFilterKey(ownerId, filters);
  const cursor = filters.cursor ? decodeGroupCursor(filters.cursor, filter) : null;
  const limit = Math.min(200, Math.max(1, Math.trunc(filters.limit ?? 50)));
  return getDb().transaction(
    async (tx) => {
      await tx.execute(sql`set local statement_timeout = '5s'`);
      await assertGroupForOwner(tx, filters.parentId, ownerId);
      const conditions = [eq(groups.ownerId, ownerId), isNull(users.blockedAt)];
      if (filters.scope === "subtree") {
        if (filters.parentId)
          conditions.push(
            sql`${groups.id} in (${groupSubtreeQuery(ownerId, filters.parentId)})`,
            ne(groups.id, filters.parentId),
          );
      } else
        conditions.push(
          filters.parentId ? eq(groups.parentId, filters.parentId) : isNull(groups.parentId),
        );
      if (filters.search) conditions.push(ilike(groups.name, `%${filters.search}%`));
      if (cursor)
        conditions.push(
          sql`(${groups.createdAt}, ${groups.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`,
        );
      const rows = await tx
        .select({
          group: groups,
          at: sql<string>`to_char(${groups.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(groups)
        .innerJoin(users, eq(groups.ownerId, users.id))
        .where(and(...conditions))
        .orderBy(desc(groups.createdAt), desc(groups.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        groups: await enrichGroups(
          tx,
          ownerId,
          page.map((row) => row.group),
        ),
        nextCursor:
          rows.length > limit && last ? encodeGroupCursor(last.at, last.group.id, filter) : null,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
