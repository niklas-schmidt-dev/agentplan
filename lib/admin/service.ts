import { and, asc, count, eq, gt, inArray, isNull, or, sql, sum } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  apiTokens,
  auditEvents,
  draftVersions,
  drafts,
  users,
  type User,
  type UserRole,
} from "@/db/schema";
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
  const [[userRow], [draftRow], [versionRow], [tokenRow]] = await Promise.all([
    db.select({ value: count() }).from(users),
    db.select({ value: count() }).from(drafts).where(liveDraftFilter),
    db
      .select({ value: count(), bytes: sum(draftVersions.sizeBytes) })
      .from(draftVersions)
      .innerJoin(drafts, eq(draftVersions.draftId, drafts.id))
      .where(liveDraftFilter),
    db.select({ value: count() }).from(apiTokens).where(activeTokenFilter),
  ]);

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

export async function listUsersWithUsage({
  limit = 50,
  offset = 0,
}: {
  limit?: number;
  offset?: number;
} = {}): Promise<AdminUserRow[]> {
  const db = getDb();
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const boundedOffset = Math.max(Math.trunc(offset), 0);
  const pageUserIds = () =>
    db
      .select({ id: users.id })
      .from(users)
      .orderBy(asc(users.createdAt), asc(users.id))
      .limit(boundedLimit)
      .offset(boundedOffset);

  const [allUsers, draftAgg, storageAgg, tokenAgg] = await Promise.all([
    db
      .select()
      .from(users)
      .orderBy(asc(users.createdAt), asc(users.id))
      .limit(boundedLimit)
      .offset(boundedOffset),
    db
      .select({ ownerId: drafts.ownerId, drafts: count() })
      .from(drafts)
      .where(and(liveDraftFilter, inArray(drafts.ownerId, pageUserIds())))
      .groupBy(drafts.ownerId),
    db
      .select({ ownerId: drafts.ownerId, bytes: sum(draftVersions.sizeBytes) })
      .from(draftVersions)
      .innerJoin(drafts, eq(draftVersions.draftId, drafts.id))
      .where(and(liveDraftFilter, inArray(drafts.ownerId, pageUserIds())))
      .groupBy(drafts.ownerId),
    db
      .select({ userId: apiTokens.userId, tokens: count() })
      .from(apiTokens)
      .where(and(activeTokenFilter, inArray(apiTokens.userId, pageUserIds())))
      .groupBy(apiTokens.userId),
  ]);

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

type UserDeletionMetadata = {
  actorUserId: string;
  targetUserId: string;
  targetEmail: string;
  storageKeys: string[];
  storageCleanup: "pending" | "complete";
  objectsDeleted?: number;
};

function parsePendingDeletionMetadata(metadata: unknown): UserDeletionMetadata | null {
  if (!metadata || typeof metadata !== "object") return null;
  const candidate = metadata as Partial<UserDeletionMetadata>;
  if (
    typeof candidate.actorUserId !== "string" ||
    typeof candidate.targetUserId !== "string" ||
    typeof candidate.targetEmail !== "string" ||
    !Array.isArray(candidate.storageKeys) ||
    !candidate.storageKeys.every((key) => typeof key === "string")
  ) {
    return null;
  }
  return {
    actorUserId: candidate.actorUserId,
    targetUserId: candidate.targetUserId,
    targetEmail: candidate.targetEmail,
    storageKeys: candidate.storageKeys,
    storageCleanup: candidate.storageCleanup === "complete" ? "complete" : "pending",
    objectsDeleted: candidate.objectsDeleted,
  };
}

async function purgeUserDeletionObjects(
  eventId: string,
  metadata: UserDeletionMetadata,
): Promise<boolean> {
  try {
    for (const storageKey of metadata.storageKeys) {
      await getStorage().delete(storageKey);
    }
    await getDb()
      .update(auditEvents)
      .set({
        eventType: "user.deleted",
        metadata: {
          ...metadata,
          storageCleanup: "complete",
          objectsDeleted: metadata.storageKeys.length,
        },
      })
      .where(and(eq(auditEvents.id, eventId), eq(auditEvents.eventType, "user.deletion_pending")));
    return true;
  } catch (error) {
    console.error("User storage cleanup remains pending", metadata.targetUserId, error);
    return false;
  }
}

export type UserDeletionPurgeResult = { purged: number; failed: number };

/** Retries durable storage-cleanup jobs left by completed account deletions. */
export async function purgePendingUserDeletionObjects(
  batchSize = 100,
): Promise<UserDeletionPurgeResult> {
  const pending = await getDb()
    .select({ id: auditEvents.id, metadata: auditEvents.metadata })
    .from(auditEvents)
    .where(eq(auditEvents.eventType, "user.deletion_pending"))
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id))
    .limit(Math.min(Math.max(Math.trunc(batchSize), 1), 100));

  let purged = 0;
  let failed = 0;
  for (const event of pending) {
    const metadata = parsePendingDeletionMetadata(event.metadata);
    if (!metadata) {
      console.error("Invalid pending user deletion audit metadata", event.id);
      failed++;
      continue;
    }
    if (await purgeUserDeletionObjects(event.id, metadata)) purged++;
    else failed++;
  }
  return { purged, failed };
}

/**
 * Atomically removes the account and its database-owned data while creating a
 * durable audit-backed R2 cleanup job. Object deletion runs after commit, so a
 * partial R2 failure can leave only inaccessible orphan objects—not a live user
 * with broken drafts—and the daily purge cron retries the idempotent cleanup.
 */
export async function deleteUserCompletely(
  actor: { userId: string },
  targetUserId: string,
): Promise<void> {
  if (actor.userId === targetUserId) {
    throw new Error("Admins cannot delete their own account");
  }
  const deletion = await getDb().transaction(async (tx) => {
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

    const metadata: UserDeletionMetadata = {
      actorUserId: actor.userId,
      targetUserId,
      targetEmail: target.email,
      storageKeys: versions.map((version) => version.storageKey),
      storageCleanup: "pending",
    };
    const [event] = await tx
      .insert(auditEvents)
      .values({
        eventType: "user.deletion_pending",
        userId: actor.userId,
        metadata,
      })
      .returning({ id: auditEvents.id });
    if (!event) throw new Error("User deletion audit insert returned no row");

    // Cascades sessions, accounts, tokens, drafts, and versions in the same
    // transaction as the durable cleanup record.
    await tx.delete(users).where(eq(users.id, targetUserId));
    return { eventId: event.id, metadata };
  });
  if (!deletion) return;

  // Best effort now; the cron retries any event that remains pending.
  await purgeUserDeletionObjects(deletion.eventId, deletion.metadata);
}
