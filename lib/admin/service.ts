import { and, asc, count, eq, gt, isNull, or, sql, sum } from "drizzle-orm";
import { getDb } from "@/db/client";
import { apiTokens, draftVersions, drafts, users, type User, type UserRole } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit/events";
import { getStorage } from "@/lib/storage";

const activeTokenFilter = and(
  isNull(apiTokens.revokedAt),
  or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, sql`now()`)),
);

const liveDraftFilter = isNull(drafts.deletedAt);

export type AdminStats = {
  users: number;
  liveDrafts: number;
  versions: number;
  storageBytes: number;
  activeTokens: number;
};

export async function getAdminStats(): Promise<AdminStats> {
  const db = getDb();
  const [userRow] = await db.select({ value: count() }).from(users);
  const [draftRow] = await db.select({ value: count() }).from(drafts).where(liveDraftFilter);
  const [versionRow] = await db
    .select({ value: count(), bytes: sum(draftVersions.sizeBytes) })
    .from(draftVersions)
    .innerJoin(drafts, eq(draftVersions.draftId, drafts.id))
    .where(liveDraftFilter);
  const [tokenRow] = await db.select({ value: count() }).from(apiTokens).where(activeTokenFilter);

  return {
    users: userRow?.value ?? 0,
    liveDrafts: draftRow?.value ?? 0,
    versions: versionRow?.value ?? 0,
    storageBytes: Number(versionRow?.bytes ?? 0),
    activeTokens: tokenRow?.value ?? 0,
  };
}

export type AdminUserRow = User & {
  draftCount: number;
  storageBytes: number;
  tokenCount: number;
};

export async function listUsersWithUsage(): Promise<AdminUserRow[]> {
  const db = getDb();
  const allUsers = await db.select().from(users).orderBy(asc(users.createdAt));
  const draftAgg = await db
    .select({ ownerId: drafts.ownerId, drafts: count() })
    .from(drafts)
    .where(liveDraftFilter)
    .groupBy(drafts.ownerId);
  const storageAgg = await db
    .select({ ownerId: drafts.ownerId, bytes: sum(draftVersions.sizeBytes) })
    .from(draftVersions)
    .innerJoin(drafts, eq(draftVersions.draftId, drafts.id))
    .where(liveDraftFilter)
    .groupBy(drafts.ownerId);
  const tokenAgg = await db
    .select({ userId: apiTokens.userId, tokens: count() })
    .from(apiTokens)
    .where(activeTokenFilter)
    .groupBy(apiTokens.userId);

  const draftsByOwner = new Map(draftAgg.map((row) => [row.ownerId, row.drafts]));
  const bytesByOwner = new Map(storageAgg.map((row) => [row.ownerId, Number(row.bytes ?? 0)]));
  const tokensByUser = new Map(tokenAgg.map((row) => [row.userId, row.tokens]));

  return allUsers.map((user) => ({
    ...user,
    draftCount: draftsByOwner.get(user.id) ?? 0,
    storageBytes: bytesByOwner.get(user.id) ?? 0,
    tokenCount: tokensByUser.get(user.id) ?? 0,
  }));
}

export async function setUserRole(
  actor: { userId: string },
  targetUserId: string,
  role: UserRole,
): Promise<void> {
  if (actor.userId === targetUserId) {
    throw new Error("Admins cannot change their own role");
  }
  const updated = await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('agentplan:admin-membership'))`);

    const [currentActor] = await tx
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, actor.userId));
    if (currentActor?.role !== "admin") {
      throw new Error("Only current admins can change user roles");
    }

    const [target] = await tx
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, targetUserId));
    if (!target) return undefined;

    if (target.role === "admin" && role === "user") {
      const [adminRow] = await tx
        .select({ value: count() })
        .from(users)
        .where(eq(users.role, "admin"));
      if ((adminRow?.value ?? 0) <= 1) {
        throw new Error("The last admin cannot be demoted");
      }
    }

    const [result] = await tx
      .update(users)
      .set({ role })
      .where(eq(users.id, targetUserId))
      .returning({ id: users.id, email: users.email });
    return result;
  });
  if (!updated) return;
  await recordAuditEvent({
    type: "user.role_changed",
    userId: actor.userId,
    metadata: { targetUserId, targetEmail: updated.email, role },
  });
}

/**
 * Hard-deletes a user and everything they own. Stored objects go first,
 * purge-style: the DB rows (and with them the object references) are only
 * removed once every object is gone, so a storage hiccup stays retryable.
 * Audit events have no FK and intentionally survive.
 */
export async function deleteUserCompletely(
  actor: { userId: string },
  targetUserId: string,
): Promise<void> {
  if (actor.userId === targetUserId) {
    throw new Error("Admins cannot delete their own account");
  }
  const db = getDb();
  const deleted = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('agentplan:admin-membership'))`);

    const [currentActor] = await tx
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, actor.userId));
    if (currentActor?.role !== "admin") {
      throw new Error("Only current admins can delete users");
    }

    const [target] = await tx
      .select({ id: users.id, email: users.email, role: users.role })
      .from(users)
      .where(eq(users.id, targetUserId));
    if (!target) return undefined;

    if (target.role === "admin") {
      const [adminRow] = await tx
        .select({ value: count() })
        .from(users)
        .where(eq(users.role, "admin"));
      if ((adminRow?.value ?? 0) <= 1) {
        throw new Error("The last admin cannot be deleted");
      }
    }

    const versions = await tx
      .select({ storageKey: draftVersions.storageKey })
      .from(draftVersions)
      .innerJoin(drafts, eq(draftVersions.draftId, drafts.id))
      .where(eq(drafts.ownerId, targetUserId));
    for (const version of versions) {
      await getStorage().delete(version.storageKey);
    }

    // Cascades sessions, accounts, tokens, drafts, and versions.
    await tx.delete(users).where(eq(users.id, targetUserId));
    return { target, objectsDeleted: versions.length };
  });
  if (!deleted) return;
  await recordAuditEvent({
    type: "user.deleted",
    userId: actor.userId,
    metadata: {
      targetUserId,
      targetEmail: deleted.target.email,
      objectsDeleted: deleted.objectsDeleted,
    },
  });
}
