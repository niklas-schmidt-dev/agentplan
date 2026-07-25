import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  ne,
  or,
  sql,
  sum,
} from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  accounts,
  apiTokens,
  auditEvents,
  blockedOauthAccounts,
  draftVersions,
  drafts,
  sessions,
  userBlocks,
  users,
  type Draft,
  type DraftVersion,
  type User,
  type UserPlan,
  type UserRole,
} from "@/db/schema";
import { assertCurrentAdmin, countActiveAdmins } from "@/lib/admin/authorization";
import { recordAuditEvent } from "@/lib/audit/events";
import { normalizeBlockedEmail } from "@/lib/auth/blocked-identities";
import { getStorage } from "@/lib/storage";

const activeTokenFilter = and(
  isNull(apiTokens.revokedAt),
  or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, sql`now()`)),
);

const liveDraftFilter = isNull(drafts.deletedAt);

export type AdminStats = {
  users: number;
  blockedUsers: number;
  liveDrafts: number;
  versions: number;
  storageBytes: number;
  activeTokens: number;
};

export async function getAdminStats(): Promise<AdminStats> {
  const db = getDb();
  const [[userRow], [blockedRow], [draftRow], [versionRow], [tokenRow]] = await Promise.all([
    db.select({ value: count() }).from(users),
    db.select({ value: count() }).from(userBlocks),
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
    blockedUsers: blockedRow?.value ?? 0,
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
  blockId: string | null;
  blockReason: string | null;
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
  const allUsers = await db
    .select()
    .from(users)
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(boundedLimit)
    .offset(boundedOffset);
  if (allUsers.length === 0) return [];
  const pageUserIds = allUsers.map((user) => user.id);

  const [draftAgg, storageAgg, tokenAgg, blockRows] = await Promise.all([
    db
      .select({ ownerId: drafts.ownerId, drafts: count() })
      .from(drafts)
      .where(and(liveDraftFilter, inArray(drafts.ownerId, pageUserIds)))
      .groupBy(drafts.ownerId),
    db
      .select({ ownerId: drafts.ownerId, bytes: sum(draftVersions.sizeBytes) })
      .from(draftVersions)
      .innerJoin(drafts, eq(draftVersions.draftId, drafts.id))
      .where(and(liveDraftFilter, inArray(drafts.ownerId, pageUserIds)))
      .groupBy(drafts.ownerId),
    db
      .select({ userId: apiTokens.userId, tokens: count() })
      .from(apiTokens)
      .where(and(activeTokenFilter, inArray(apiTokens.userId, pageUserIds)))
      .groupBy(apiTokens.userId),
    db
      .select({
        userId: userBlocks.userId,
        id: userBlocks.id,
        reason: userBlocks.reason,
      })
      .from(userBlocks)
      .where(inArray(userBlocks.userId, pageUserIds)),
  ]);

  const draftsByOwner = new Map(draftAgg.map((row) => [row.ownerId, row.drafts]));
  const bytesByOwner = new Map(storageAgg.map((row) => [row.ownerId, Number(row.bytes ?? 0)]));
  const tokensByUser = new Map(tokenAgg.map((row) => [row.userId, row.tokens]));
  const blocksByUser = new Map(blockRows.map((row) => [row.userId, row]));

  return allUsers.map((user) => ({
    ...user,
    draftCount: draftsByOwner.get(user.id) ?? 0,
    storageBytes: bytesByOwner.get(user.id) ?? 0,
    tokenCount: tokensByUser.get(user.id) ?? 0,
    blockId: blocksByUser.get(user.id)?.id ?? null,
    blockReason: blocksByUser.get(user.id)?.reason ?? null,
  }));
}

export type IdentityBlockRow = {
  id: string;
  userId: string;
  normalizedEmail: string;
  reason: string;
  blockedByUserId: string;
  createdAt: Date;
  accountRetained: boolean;
  oauthIdentityCount: number;
};

export type IdentityBlockPage = {
  blocks: IdentityBlockRow[];
  total: number;
};

export async function listIdentityBlocks({
  search,
  limit = 50,
  offset = 0,
}: {
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<IdentityBlockPage> {
  const db = getDb();
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const boundedOffset = Math.max(Math.trunc(offset), 0);
  const normalizedSearch = search?.trim().slice(0, 200);
  const where = normalizedSearch
    ? or(
        ilike(userBlocks.normalizedEmail, `%${normalizedSearch}%`),
        ilike(userBlocks.reason, `%${normalizedSearch}%`),
      )
    : undefined;

  const [[totalRow], rows] = await Promise.all([
    db.select({ value: count() }).from(userBlocks).where(where),
    db
      .select({
        id: userBlocks.id,
        userId: userBlocks.userId,
        normalizedEmail: userBlocks.normalizedEmail,
        reason: userBlocks.reason,
        blockedByUserId: userBlocks.blockedByUserId,
        createdAt: userBlocks.createdAt,
        retainedUserId: users.id,
      })
      .from(userBlocks)
      .leftJoin(users, eq(userBlocks.userId, users.id))
      .where(where)
      .orderBy(desc(userBlocks.createdAt), desc(userBlocks.id))
      .limit(boundedLimit)
      .offset(boundedOffset),
  ]);

  const blockIds = rows.map((row) => row.id);
  const oauthCounts =
    blockIds.length === 0
      ? []
      : await db
          .select({ blockId: blockedOauthAccounts.blockId, value: count() })
          .from(blockedOauthAccounts)
          .where(inArray(blockedOauthAccounts.blockId, blockIds))
          .groupBy(blockedOauthAccounts.blockId);
  const oauthCountByBlock = new Map(oauthCounts.map((row) => [row.blockId, row.value]));

  return {
    total: totalRow?.value ?? 0,
    blocks: rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      normalizedEmail: row.normalizedEmail,
      reason: row.reason,
      blockedByUserId: row.blockedByUserId,
      createdAt: row.createdAt,
      accountRetained: row.retainedUserId !== null,
      oauthIdentityCount: oauthCountByBlock.get(row.id) ?? 0,
    })),
  };
}

export type AdminDraftRow = Draft & {
  ownerEmail: string;
  ownerBlocked: boolean;
  currentVersion: Pick<DraftVersion, "versionNumber" | "sizeBytes"> | null;
};

export type AdminDraftPage = {
  drafts: AdminDraftRow[];
  total: number;
};

/** Lists live uploads for moderation, optionally narrowed to one owner. */
export async function listDraftsForAdmin({
  search,
  ownerId,
  limit = 50,
  offset = 0,
}: {
  search?: string;
  ownerId?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<AdminDraftPage> {
  const db = getDb();
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const boundedOffset = Math.max(Math.trunc(offset), 0);
  const normalizedSearch = search?.trim().slice(0, 200);
  const conditions = [liveDraftFilter];
  if (ownerId) conditions.push(eq(drafts.ownerId, ownerId));
  if (normalizedSearch) {
    const pattern = `%${normalizedSearch}%`;
    conditions.push(
      or(ilike(drafts.title, pattern), ilike(drafts.slug, pattern), ilike(users.email, pattern))!,
    );
  }
  const where = and(...conditions);

  const [[totalRow], rows] = await Promise.all([
    db
      .select({ value: count() })
      .from(drafts)
      .innerJoin(users, eq(drafts.ownerId, users.id))
      .where(where),
    db
      .select({
        draft: drafts,
        ownerEmail: users.email,
        ownerBlockedAt: users.blockedAt,
        versionNumber: draftVersions.versionNumber,
        sizeBytes: draftVersions.sizeBytes,
      })
      .from(drafts)
      .innerJoin(users, eq(drafts.ownerId, users.id))
      .leftJoin(draftVersions, eq(drafts.currentVersionId, draftVersions.id))
      .where(where)
      .orderBy(desc(drafts.updatedAt), desc(drafts.id))
      .limit(boundedLimit)
      .offset(boundedOffset),
  ]);

  return {
    total: totalRow?.value ?? 0,
    drafts: rows.map((row) => ({
      ...row.draft,
      ownerEmail: row.ownerEmail,
      ownerBlocked: row.ownerBlockedAt !== null,
      currentVersion:
        row.versionNumber === null
          ? null
          : {
              versionNumber: row.versionNumber,
              sizeBytes: row.sizeBytes ?? 0,
            },
    })),
  };
}

export async function setUserPlan(
  actor: { userId: string },
  targetUserId: string,
  plan: UserPlan,
): Promise<void> {
  const changed = await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('agentplan:admin-membership'))`);
    await assertCurrentAdmin(tx, actor.userId);

    const [target] = await tx
      .select({ email: users.email, plan: users.plan, blockedAt: users.blockedAt })
      .from(users)
      .where(eq(users.id, targetUserId));
    if (!target) throw new Error("User not found");
    if (target.blockedAt) throw new Error("Blocked users cannot have their plan changed");
    if (target.plan === plan) return null;

    const [updated] = await tx
      .update(users)
      .set({ plan })
      .where(eq(users.id, targetUserId))
      .returning({ email: users.email });
    if (!updated) throw new Error("User not found");
    return { email: updated.email, from: target.plan };
  });
  if (!changed) return;

  await recordAuditEvent({
    type: "user.plan_changed",
    userId: actor.userId,
    metadata: {
      targetUserId,
      targetEmail: changed.email,
      from: changed.from,
      to: plan,
    },
  });
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
    await assertCurrentAdmin(tx, actor.userId);

    const [target] = await tx
      .select({ role: users.role, blockedAt: users.blockedAt })
      .from(users)
      .where(eq(users.id, targetUserId));
    if (!target) throw new Error("User not found");
    if (target.blockedAt) throw new Error("Blocked users cannot have their role changed");

    if (target.role === "admin" && role === "user") {
      if ((await countActiveAdmins(tx)) <= 1) {
        throw new Error("The last admin cannot be demoted");
      }
    }

    const [result] = await tx
      .update(users)
      .set({ role })
      .where(eq(users.id, targetUserId))
      .returning({ id: users.id, email: users.email });
    if (!result) throw new Error("User not found");
    return result;
  });
  await recordAuditEvent({
    type: "user.role_changed",
    userId: actor.userId,
    metadata: { targetUserId, targetEmail: updated.email, role },
  });
}

/**
 * Immediately removes an upload from every public and authenticated read path.
 * The existing deleted-draft purge permanently removes its stored versions
 * after the configured recovery window.
 */
export async function removeDraftAsAdmin(
  actor: { userId: string },
  draftId: string,
): Promise<{ ownerId: string; slug: string } | null> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('agentplan:admin-membership'))`);
    await assertCurrentAdmin(tx, actor.userId);

    const [removed] = await tx
      .update(drafts)
      .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(drafts.id, draftId), isNull(drafts.deletedAt)))
      .returning({ id: drafts.id, ownerId: drafts.ownerId, slug: drafts.slug });
    if (!removed) return null;

    await tx.insert(auditEvents).values({
      eventType: "draft.moderated",
      userId: actor.userId,
      draftId: removed.id,
      metadata: {
        ownerId: removed.ownerId,
        slug: removed.slug,
      },
    });
    return { ownerId: removed.ownerId, slug: removed.slug };
  });
}

function normalizeBlockReason(reason: string): string {
  const normalized = reason.trim();
  if (normalized.length < 1 || normalized.length > 500) {
    throw new Error("Block reason must be between 1 and 500 characters");
  }
  return normalized;
}

export async function blockUser(
  actor: { userId: string },
  targetUserId: string,
  reason: string,
): Promise<void> {
  if (actor.userId === targetUserId) {
    throw new Error("Admins cannot block their own account");
  }
  const normalizedReason = normalizeBlockReason(reason);

  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('agentplan:admin-membership'))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('agentplan:signup-policy'))`);
    await assertCurrentAdmin(tx, actor.userId);

    // Storage serialization comes last in the global lifecycle lock order.
    // In-flight owner mutations finish first; later ones observe blocked_at.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('agentplan:user-storage'), hashtext(${targetUserId}))`,
    );

    const [target] = await tx
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        blockedAt: users.blockedAt,
      })
      .from(users)
      .where(eq(users.id, targetUserId))
      .for("update");
    if (!target) throw new Error("User not found");

    const [existingBlock] = await tx
      .select({ id: userBlocks.id })
      .from(userBlocks)
      .where(eq(userBlocks.userId, targetUserId))
      .limit(1);
    if (existingBlock || target.blockedAt) return;

    if (target.role === "admin" && (await countActiveAdmins(tx)) <= 1) {
      throw new Error("The last active admin cannot be blocked");
    }

    const oauthAccounts = await tx
      .select({ providerId: accounts.providerId, accountId: accounts.accountId })
      .from(accounts)
      .where(and(eq(accounts.userId, targetUserId), ne(accounts.providerId, "credential")));
    const [block] = await tx
      .insert(userBlocks)
      .values({
        userId: target.id,
        normalizedEmail: normalizeBlockedEmail(target.email),
        reason: normalizedReason,
        blockedByUserId: actor.userId,
      })
      .returning({ id: userBlocks.id });
    if (!block) throw new Error("Block insert returned no row");

    if (oauthAccounts.length > 0) {
      await tx
        .insert(blockedOauthAccounts)
        .values(
          oauthAccounts.map((account) => ({
            blockId: block.id,
            providerId: account.providerId,
            accountId: account.accountId,
          })),
        )
        .onConflictDoNothing();
    }

    await tx.delete(sessions).where(eq(sessions.userId, targetUserId));
    await tx
      .update(apiTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(apiTokens.userId, targetUserId), isNull(apiTokens.revokedAt)));
    await tx.insert(auditEvents).values({
      eventType: "user.blocked",
      userId: actor.userId,
      metadata: {
        targetUserId,
        targetEmail: target.email,
        blockId: block.id,
        reason: normalizedReason,
        oauthIdentityCount: oauthAccounts.length,
      },
    });
  });
}

export async function unblockIdentityBlock(
  actor: { userId: string },
  blockId: string,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('agentplan:admin-membership'))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('agentplan:signup-policy'))`);
    await assertCurrentAdmin(tx, actor.userId);

    const [block] = await tx
      .select({
        id: userBlocks.id,
        userId: userBlocks.userId,
        normalizedEmail: userBlocks.normalizedEmail,
      })
      .from(userBlocks)
      .where(eq(userBlocks.id, blockId))
      .for("update");
    if (!block) return;

    await tx.delete(userBlocks).where(eq(userBlocks.id, block.id));
    await tx.insert(auditEvents).values({
      eventType: "user.unblocked",
      userId: actor.userId,
      metadata: {
        blockId: block.id,
        targetUserId: block.userId,
        targetEmail: block.normalizedEmail,
      },
    });
  });
}

type UserDeletionMetadata = {
  targetUserId: string;
  storageKeys: string[];
  storageCleanup: "pending" | "complete";
  objectsDeleted?: number;
  identityBlockId?: string;
};

function parsePendingDeletionMetadata(metadata: unknown): UserDeletionMetadata | null {
  if (!metadata || typeof metadata !== "object") return null;
  const candidate = metadata as Partial<UserDeletionMetadata>;
  if (
    typeof candidate.targetUserId !== "string" ||
    !Array.isArray(candidate.storageKeys) ||
    !candidate.storageKeys.every((key) => typeof key === "string")
  ) {
    return null;
  }
  return {
    targetUserId: candidate.targetUserId,
    storageKeys: candidate.storageKeys,
    storageCleanup: candidate.storageCleanup === "complete" ? "complete" : "pending",
    objectsDeleted: candidate.objectsDeleted,
    identityBlockId: candidate.identityBlockId,
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
          storageCleanup: "complete",
          objectsDeleted: metadata.storageKeys.length,
        },
      })
      .where(and(eq(auditEvents.id, eventId), eq(auditEvents.eventType, "user.deletion_pending")));
    return true;
  } catch (error) {
    console.error("User storage cleanup remains pending", eventId, error);
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
async function deleteUser(
  actor: { userId: string },
  targetUserId: string,
  mode: "delete-only" | "delete-and-block",
  reason?: string,
): Promise<void> {
  if (actor.userId === targetUserId) {
    throw new Error("Admins cannot delete their own account");
  }
  const deletion = await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('agentplan:admin-membership'))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('agentplan:signup-policy'))`);
    await assertCurrentAdmin(tx, actor.userId);

    // Uploads take this same lock before checking the owner and writing. Keep
    // it ahead of the user-row lock to avoid a row/advisory lock inversion.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('agentplan:user-storage'), hashtext(${targetUserId}))`,
    );

    const [target] = await tx
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        blockedAt: users.blockedAt,
      })
      .from(users)
      .where(eq(users.id, targetUserId))
      .for("update");
    if (!target) return undefined;

    const [existingBlock] = await tx
      .select({ id: userBlocks.id, reason: userBlocks.reason })
      .from(userBlocks)
      .where(eq(userBlocks.userId, targetUserId))
      .limit(1);
    if (mode === "delete-only" && (target.blockedAt || existingBlock)) {
      throw new Error("Blocked accounts must be unblocked before delete-only");
    }

    if (target.role === "admin" && !target.blockedAt && (await countActiveAdmins(tx)) <= 1) {
      throw new Error("The last active admin cannot be deleted");
    }

    let identityBlockId = existingBlock?.id;
    if (mode === "delete-and-block" && !identityBlockId) {
      const normalizedReason = normalizeBlockReason(reason ?? "");
      const oauthAccounts = await tx
        .select({ providerId: accounts.providerId, accountId: accounts.accountId })
        .from(accounts)
        .where(and(eq(accounts.userId, targetUserId), ne(accounts.providerId, "credential")));
      const [block] = await tx
        .insert(userBlocks)
        .values({
          userId: target.id,
          normalizedEmail: normalizeBlockedEmail(target.email),
          reason: normalizedReason,
          blockedByUserId: actor.userId,
        })
        .returning({ id: userBlocks.id });
      if (!block) throw new Error("Block insert returned no row");
      identityBlockId = block.id;
      if (oauthAccounts.length > 0) {
        await tx
          .insert(blockedOauthAccounts)
          .values(
            oauthAccounts.map((account) => ({
              blockId: block.id,
              providerId: account.providerId,
              accountId: account.accountId,
            })),
          )
          .onConflictDoNothing();
      }
      await tx.insert(auditEvents).values({
        eventType: "user.blocked",
        userId: actor.userId,
        metadata: {
          targetUserId,
          targetEmail: target.email,
          blockId: block.id,
          reason: normalizedReason,
          oauthIdentityCount: oauthAccounts.length,
        },
      });
    }

    const versions = await tx
      .select({ storageKey: draftVersions.storageKey })
      .from(draftVersions)
      .innerJoin(drafts, eq(draftVersions.draftId, drafts.id))
      .where(eq(drafts.ownerId, targetUserId));

    const metadata: UserDeletionMetadata = {
      targetUserId,
      storageKeys: versions.map((version) => version.storageKey),
      storageCleanup: "pending",
      identityBlockId,
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

export async function deleteUserCompletely(
  actor: { userId: string },
  targetUserId: string,
): Promise<void> {
  await deleteUser(actor, targetUserId, "delete-only");
}

export async function deleteAndBlockUser(
  actor: { userId: string },
  targetUserId: string,
  reason: string,
): Promise<void> {
  await deleteUser(actor, targetUserId, "delete-and-block", reason);
}
