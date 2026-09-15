import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { drafts, groups, uploadIntents, users, type Group } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit/events";
import { liveDraftCondition } from "@/lib/drafts/expiration";
import { createGroupSchema, moveDraftsSchema, patchGroupSchema } from "@/lib/validation/groups";
import { assertGroupForOwner, groupSubtreeQuery, type DbTransaction } from "./access";
import { GroupNotFoundError, InvalidGroupError } from "./errors";
import { z } from "zod";

type Actor = { userId: string; tokenId?: string };
type CreateInput = z.input<typeof createGroupSchema>;
type UpdateInput = z.input<typeof patchGroupSchema>;

async function lockOwner(tx: DbTransaction, ownerId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('agentplan:user-storage'), hashtext(${ownerId}))`,
  );
  await tx.execute(sql`set local statement_timeout = '5s'`);
  const [owner] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, ownerId), isNull(users.blockedAt)))
    .for("update");
  if (!owner) throw new GroupNotFoundError();
}
async function ownedGroup(tx: DbTransaction, ownerId: string, id: string) {
  if (!z.uuid().safeParse(id).success) throw new GroupNotFoundError();
  const [group] = await tx
    .select()
    .from(groups)
    .where(and(eq(groups.id, id), eq(groups.ownerId, ownerId)))
    .for("update");
  if (!group) throw new GroupNotFoundError();
  return group;
}

export async function createGroup(actor: Actor, input: CreateInput): Promise<Group> {
  const parsed = createGroupSchema.safeParse(input);
  if (!parsed.success)
    throw new InvalidGroupError(parsed.error.issues[0]?.message ?? "Invalid group.");
  const group = await getDb().transaction(async (tx) => {
    await lockOwner(tx, actor.userId);
    await assertGroupForOwner(tx, parsed.data.parentId, actor.userId);
    const [created] = await tx
      .insert(groups)
      .values({ ...parsed.data, ownerId: actor.userId })
      .returning();
    if (!created) throw new Error("Group insert returned no row");
    return created;
  });
  await recordAuditEvent({
    type: "group.created",
    ...actor,
    metadata: { groupId: group.id, parentId: group.parentId },
  });
  return group;
}

export async function updateGroup(actor: Actor, id: string, input: UpdateInput): Promise<Group> {
  const parsed = patchGroupSchema.safeParse(input);
  if (!parsed.success)
    throw new InvalidGroupError(parsed.error.issues[0]?.message ?? "Invalid group.");
  const result = await getDb().transaction(async (tx) => {
    await lockOwner(tx, actor.userId);
    const group = await ownedGroup(tx, actor.userId, id);
    if (parsed.data.parentId !== undefined) {
      await assertGroupForOwner(tx, parsed.data.parentId, actor.userId);
      if (parsed.data.parentId !== null) {
        const cycle = await tx.execute(
          sql`select id from (${groupSubtreeQuery(actor.userId, group.id)}) subtree where id = ${parsed.data.parentId}::uuid limit 1`,
        );
        if (cycle.rows.length)
          throw new InvalidGroupError(
            "A group cannot be moved into itself or one of its subgroups.",
          );
      }
    }
    const changed = Object.entries(parsed.data).some(
      ([key, value]) => value !== undefined && group[key as keyof Group] !== value,
    );
    if (!changed) return { group, changed: false, moved: false };
    const [updated] = await tx
      .update(groups)
      .set({ ...parsed.data, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(groups.id, id), eq(groups.ownerId, actor.userId)))
      .returning();
    return {
      group: updated!,
      changed: true,
      moved: parsed.data.parentId !== undefined && parsed.data.parentId !== group.parentId,
    };
  });
  if (result.changed)
    await recordAuditEvent({
      type: result.moved ? "group.moved" : "group.updated",
      ...actor,
      metadata: { groupId: id, parentId: result.group.parentId },
    });
  return result.group;
}

/** Dissolve only this container; promote its direct children/files without deleting content. */
export async function dissolveGroup(actor: Actor, id: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    await lockOwner(tx, actor.userId);
    const group = await ownedGroup(tx, actor.userId, id);
    await assertGroupForOwner(tx, group.parentId, actor.userId);
    await tx
      .update(drafts)
      .set({ groupId: group.parentId, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(drafts.ownerId, actor.userId), eq(drafts.groupId, id)));
    await tx
      .update(groups)
      .set({ parentId: group.parentId, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(groups.ownerId, actor.userId), eq(groups.parentId, id)));
    await tx
      .update(uploadIntents)
      .set({ targetGroupId: group.parentId })
      .where(and(eq(uploadIntents.ownerId, actor.userId), eq(uploadIntents.targetGroupId, id)));
    await tx.delete(groups).where(and(eq(groups.id, id), eq(groups.ownerId, actor.userId)));
  });
  await recordAuditEvent({ type: "group.dissolved", ...actor, metadata: { groupId: id } });
}

export async function moveDraftsToGroup(
  actor: Actor,
  draftIds: string[],
  groupId: string | null,
): Promise<{ movedCount: number }> {
  const parsed = moveDraftsSchema.safeParse({ draftIds, groupId });
  if (!parsed.success)
    throw new InvalidGroupError(parsed.error.issues[0]?.message ?? "Invalid move.");
  draftIds = parsed.data.draftIds;
  groupId = parsed.data.groupId;
  const moved = await getDb().transaction(async (tx) => {
    await lockOwner(tx, actor.userId);
    await assertGroupForOwner(tx, groupId, actor.userId);
    const rows = await tx
      .select({ id: drafts.id, groupId: drafts.groupId })
      .from(drafts)
      .where(
        and(eq(drafts.ownerId, actor.userId), inArray(drafts.id, draftIds), liveDraftCondition),
      )
      .for("update");
    if (rows.length !== draftIds.length) throw new GroupNotFoundError();
    const ids = rows.filter((row) => row.groupId !== groupId).map((row) => row.id);
    if (!ids.length) return [];
    const updated = await tx
      .update(drafts)
      .set({ groupId, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(drafts.ownerId, actor.userId), inArray(drafts.id, ids), liveDraftCondition))
      .returning({ id: drafts.id });
    if (updated.length !== ids.length) throw new GroupNotFoundError();
    return ids;
  });
  await Promise.all(
    moved.map((draftId) =>
      recordAuditEvent({ type: "draft.moved", ...actor, draftId, metadata: { groupId } }),
    ),
  );
  return { movedCount: moved.length };
}
