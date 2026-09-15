import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { groups, users } from "@/db/schema";
import { GroupNotFoundError, InvalidGroupError } from "./errors";

export type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type GroupReader = Pick<Database, "select" | "execute">;

/** Called inside the caller's storage-locked transaction for writes. */
export async function assertGroupForOwner(
  db: GroupReader,
  groupId: string | null | undefined,
  ownerId: string,
): Promise<void> {
  if (groupId == null) return;
  const [group] = await db
    .select({ id: groups.id })
    .from(groups)
    .innerJoin(users, eq(groups.ownerId, users.id))
    .where(and(eq(groups.id, groupId), eq(groups.ownerId, ownerId), isNull(users.blockedAt)))
    .limit(1);
  if (!group) throw new GroupNotFoundError();
}

/** UNION deduplicates IDs, including in a malformed cyclic tree. */
export function groupSubtreeQuery(ownerId: string, groupId: string) {
  return sql`with recursive descendants(id) as (
    select g.id from groups g join users u on u.id = g.owner_id
    where g.id = ${groupId}::uuid and g.owner_id = ${ownerId} and u.blocked_at is null
    union
    select g.id from groups g join descendants d on g.parent_id = d.id
    where g.owner_id = ${ownerId}
  ) select id from descendants`;
}

/** Run with a bounded statement timeout and the same snapshot as the consuming query. */
export async function assertValidGroupSubtree(db: GroupReader, ownerId: string, groupId: string) {
  const result = await db.execute(sql`with recursive tree as (
    select g.id, array[g.id] as visited, false as cycle from groups g
    where g.owner_id = ${ownerId} and g.id = ${groupId}::uuid
    union all
    select g.id, t.visited || g.id, g.id = any(t.visited)
    from tree t join groups g on g.parent_id = t.id
    where g.owner_id = ${ownerId} and not t.cycle
  ) select id from tree where cycle limit 1`);
  if (result.rows.length) throw new InvalidGroupError("The group hierarchy contains a cycle.");
}
