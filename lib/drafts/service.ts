import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  draftVersions,
  drafts,
  uploadIntentFiles,
  uploadIntentReclaims,
  uploadIntents,
  users,
  type Draft,
  type DraftVersion,
  type Visibility,
} from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit/events";
import { hashPassword } from "@/lib/drafts/password";
import { generateSlug } from "@/lib/drafts/slug";
import { consumeUploadRateLimit, lockAndAssertUploadQuota } from "@/lib/limits/enforce";
import { retentionForKind } from "@/lib/limits/plans";
import { getStorage, storageKeyFor } from "@/lib/storage";
import { queueStorageDeletion, tryDeleteStorageKey } from "@/lib/storage/cleanup";
import { listVersionStorageKeys } from "@/lib/drafts/version-storage";

export type UploadSource = "browser" | "api_token";

/** Thrown when a draft is soft-deleted mid-operation; callers map this to 404. */
export class DraftNotFoundError extends Error {
  constructor() {
    super("Draft not found");
    this.name = "DraftNotFoundError";
  }
}

/** Thrown when password visibility is requested without a password to set. */
export class PasswordRequiredError extends Error {
  constructor() {
    super("A password is required for password-protected visibility");
    this.name = "PasswordRequiredError";
  }
}

/** Thrown when a password is paired with a non-password visibility. */
export class PasswordVisibilityConflictError extends Error {
  constructor() {
    super("A password cannot be combined with public or private visibility");
    this.name = "PasswordVisibilityConflictError";
  }
}

export class DraftWriteConflictError extends Error {
  constructor() {
    super("Another upload is already pending for this draft");
    this.name = "DraftWriteConflictError";
  }
}

const HTML_CONTENT_TYPE = "text/html; charset=utf-8";
const SLUG_ATTEMPTS = 5;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

/**
 * Upload flow: serialize account lifecycle, write private storage, and commit
 * metadata as one transaction-scoped unit. If the transaction fails after the
 * object write, try to remove the orphaned object.
 */
export async function createDraftWithFirstVersion(params: {
  ownerId: string;
  title: string;
  visibility: Visibility;
  bytes: Uint8Array;
  originalFilename?: string;
  source: UploadSource;
  tokenId?: string;
  /** Set only when the authenticated route reserved the rate budget before reading the body. */
  rateLimitConsumed?: boolean;
  /** Required plaintext when visibility is "password"; invalid otherwise. */
  password?: string;
}): Promise<{ draft: Draft; version: DraftVersion }> {
  const db = getDb();
  const draftId = randomUUID();
  const versionId = randomUUID();
  const storageKey = storageKeyFor(params.ownerId, draftId, versionId);
  const contentSha256 = sha256Hex(params.bytes);

  if (params.visibility === "password" && !params.password) {
    throw new PasswordRequiredError();
  }
  if (params.visibility !== "password" && params.password !== undefined) {
    throw new PasswordVisibilityConflictError();
  }
  const passwordHash =
    params.visibility === "password" ? await hashPassword(params.password!) : null;

  if (!params.rateLimitConsumed) await consumeUploadRateLimit(params.ownerId);

  let stored = false;
  try {
    let lastError: unknown;
    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
      const slug = generateSlug(params.title, params.visibility === "public");
      try {
        const result = await db.transaction(async (tx) => {
          // Account deletion takes the same lock before capturing storage keys.
          // Keeping the bounded object write inside this transaction makes the
          // database row and deletion cleanup inventory one serialized unit.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext('agentplan:user-storage'), hashtext(${params.ownerId}))`,
          );
          const [owner] = await tx
            .select({ id: users.id, blockedAt: users.blockedAt })
            .from(users)
            .where(eq(users.id, params.ownerId))
            .for("update");
          if (!owner || owner.blockedAt) throw new DraftNotFoundError();
          await lockAndAssertUploadQuota(
            {
              userId: params.ownerId,
              sizeBytes: params.bytes.byteLength,
              newDraft: true,
            },
            tx,
          );
          await getStorage().put(storageKey, params.bytes, HTML_CONTENT_TYPE);
          stored = true;
          const [draft] = await tx
            .insert(drafts)
            .values({
              id: draftId,
              ownerId: params.ownerId,
              slug,
              title: params.title,
              visibility: params.visibility,
              passwordHash,
            })
            .returning();
          const [version] = await tx
            .insert(draftVersions)
            .values({
              id: versionId,
              draftId,
              versionNumber: 1,
              storageKey,
              contentSha256,
              contentType: "text/html",
              originalFilename: params.originalFilename ?? "upload.html",
              sizeBytes: params.bytes.byteLength,
              totalSizeBytes: params.bytes.byteLength,
              source: params.source,
              createdByTokenId: params.tokenId ?? null,
            })
            .returning();
          const [updated] = await tx
            .update(drafts)
            .set({ currentVersionId: versionId })
            .where(eq(drafts.id, draftId))
            .returning();
          if (!draft || !version || !updated) throw new Error("Draft insert returned no rows");
          return { draft: updated, version };
        });
        await recordAuditEvent({
          type: "draft.created",
          userId: params.ownerId,
          draftId,
          tokenId: params.tokenId,
          metadata: {
            slug: result.draft.slug,
            visibility: params.visibility,
            sizeBytes: params.bytes.byteLength,
          },
        });
        return result;
      } catch (error) {
        lastError = error;
        if (!isUniqueViolation(error)) throw error;
        // Slug collision — retry the whole transaction with a fresh slug.
      }
    }
    throw lastError ?? new Error("Could not generate a unique slug");
  } catch (error) {
    if (stored) {
      await getStorage()
        .delete(storageKey)
        .catch((cleanupError) =>
          console.error("Failed to clean up orphaned object", storageKey, cleanupError),
        );
    }
    throw error;
  }
}

export async function addVersionToDraft(params: {
  draft: Draft;
  bytes: Uint8Array;
  originalFilename?: string;
  source: UploadSource;
  tokenId?: string;
  auditType?: "draft.version_created" | "draft.version_restored";
  auditMetadata?: Record<string, unknown>;
  /** Set only when the caller consumed the budget before resource retrieval. */
  rateLimitConsumed?: boolean;
}): Promise<{ version: DraftVersion; draft: Draft }> {
  const db = getDb();
  const versionId = randomUUID();
  const storageKey = storageKeyFor(params.draft.ownerId, params.draft.id, versionId);
  const contentSha256 = sha256Hex(params.bytes);

  if (!params.rateLimitConsumed) await consumeUploadRateLimit(params.draft.ownerId);

  let stored = false;
  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('agentplan:user-storage'), hashtext(${params.draft.ownerId}))`,
      );
      const [owner] = await tx
        .select({ id: users.id, blockedAt: users.blockedAt })
        .from(users)
        .where(eq(users.id, params.draft.ownerId))
        .for("update");
      if (!owner || owner.blockedAt) throw new DraftNotFoundError();
      const [pending] = await tx
        .select({ id: uploadIntents.id })
        .from(uploadIntents)
        .where(
          and(
            eq(uploadIntents.targetDraftId, params.draft.id),
            eq(uploadIntents.status, "pending"),
            sql`${uploadIntents.expiresAt} > now()`,
          ),
        )
        .limit(1);
      if (pending) throw new DraftWriteConflictError();
      const limits = await lockAndAssertUploadQuota(
        {
          userId: params.draft.ownerId,
          sizeBytes: params.bytes.byteLength,
          newDraft: false,
        },
        tx,
      );
      await getStorage().put(storageKey, params.bytes, HTML_CONTENT_TYPE);
      stored = true;
      // Serialize version numbering per draft. A draft that was soft-deleted
      // between the caller's check and this lock is a 404, not a server error.
      const [locked] = await tx
        .select({ id: drafts.id, deletedAt: drafts.deletedAt })
        .from(drafts)
        .where(eq(drafts.id, params.draft.id))
        .for("update");
      if (!locked || locked.deletedAt) throw new DraftNotFoundError();

      const [row] = await tx
        .select({ maxVersion: max(draftVersions.versionNumber) })
        .from(draftVersions)
        .where(eq(draftVersions.draftId, params.draft.id));
      const nextVersion = (row?.maxVersion ?? 0) + 1;

      const [version] = await tx
        .insert(draftVersions)
        .values({
          id: versionId,
          draftId: params.draft.id,
          versionNumber: nextVersion,
          storageKey,
          contentSha256,
          contentType: "text/html",
          originalFilename: params.originalFilename ?? "upload.html",
          sizeBytes: params.bytes.byteLength,
          totalSizeBytes: params.bytes.byteLength,
          source: params.source,
          createdByTokenId: params.tokenId ?? null,
        })
        .returning();
      if (!version) throw new Error("Version insert returned no rows");

      // Return the freshly updated draft so callers serialize a current
      // updatedAt / currentVersionId rather than their stale input copy.
      const [updatedDraft] = await tx
        .update(drafts)
        .set({ currentVersionId: versionId, updatedAt: sql`now()` })
        .where(eq(drafts.id, params.draft.id))
        .returning();
      if (!updatedDraft) throw new DraftNotFoundError();

      // Version retention: a stable link must keep accepting uploads, so old
      // versions are pruned instead of hard-failing at a cap. The newest
      // (current) version is always inside the keep window.
      let pruned: { id: string }[] = [];
      let prunedKeys: string[] = [];
      const keepVersions = retentionForKind(limits, params.draft.kind);
      if (keepVersions !== null) {
        pruned = await tx
          .select({ id: draftVersions.id })
          .from(draftVersions)
          .where(
            and(
              eq(draftVersions.draftId, params.draft.id),
              params.draft.kind === "html" ? eq(draftVersions.isBundle, false) : undefined,
            ),
          )
          .orderBy(desc(draftVersions.versionNumber))
          .offset(keepVersions);
        if (pruned.length) {
          prunedKeys = await listVersionStorageKeys(
            pruned.map((stale) => stale.id),
            tx,
          );
          for (const storageKey of prunedKeys) {
            await queueStorageDeletion({ storageKey, reason: "version_retention" }, tx);
          }
          await tx.delete(draftVersions).where(
            inArray(
              draftVersions.id,
              pruned.map((p) => p.id),
            ),
          );
        }
      }
      return { version, draft: updatedDraft, pruned, prunedKeys };
    });

    for (const storageKey of result.prunedKeys) {
      await tryDeleteStorageKey(storageKey);
    }

    await recordAuditEvent({
      type: params.auditType ?? "draft.version_created",
      userId: params.draft.ownerId,
      draftId: params.draft.id,
      tokenId: params.tokenId,
      metadata: {
        versionNumber: result.version.versionNumber,
        sizeBytes: params.bytes.byteLength,
        ...(result.pruned.length ? { prunedVersions: result.pruned.length } : {}),
        ...params.auditMetadata,
      },
    });
    return { version: result.version, draft: result.draft };
  } catch (error) {
    if (stored) {
      await getStorage()
        .delete(storageKey)
        .catch((cleanupError) =>
          console.error("Failed to clean up orphaned object", storageKey, cleanupError),
        );
    }
    throw error;
  }
}

/** Restore = a provider-side copy into a new immutable version key. */
export async function restoreVersion(params: {
  draft: Draft;
  version: DraftVersion;
  source: UploadSource;
  tokenId?: string;
  rateLimitConsumed?: boolean;
}): Promise<{ version: DraftVersion; draft: Draft }> {
  if (!params.rateLimitConsumed) await consumeUploadRateLimit(params.draft.ownerId);
  const versionId = randomUUID();
  const extension = params.version.storageKey.split(".").pop() || "html";
  const storageKey = storageKeyFor(params.draft.ownerId, params.draft.id, versionId, extension);
  let copied = false;
  try {
    const result = await getDb().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('agentplan:user-storage'), hashtext(${params.draft.ownerId}))`,
      );
      const [owner] = await tx
        .select({ id: users.id, blockedAt: users.blockedAt })
        .from(users)
        .where(eq(users.id, params.draft.ownerId))
        .for("update");
      if (!owner || owner.blockedAt) throw new DraftNotFoundError();
      const [pending] = await tx
        .select({ id: uploadIntents.id })
        .from(uploadIntents)
        .where(
          and(
            eq(uploadIntents.targetDraftId, params.draft.id),
            eq(uploadIntents.status, "pending"),
            sql`${uploadIntents.expiresAt} > now()`,
          ),
        )
        .limit(1);
      if (pending) throw new DraftWriteConflictError();
      const limits = await lockAndAssertUploadQuota(
        {
          userId: params.draft.ownerId,
          sizeBytes: params.version.sizeBytes,
          newDraft: false,
        },
        tx,
      );
      const [locked] = await tx
        .select({ id: drafts.id, kind: drafts.kind, deletedAt: drafts.deletedAt })
        .from(drafts)
        .where(eq(drafts.id, params.draft.id))
        .for("update");
      if (!locked || locked.deletedAt) throw new DraftNotFoundError();

      await getStorage().copy(params.version.storageKey, storageKey, params.version.contentType);
      copied = true;
      const [numberRow] = await tx
        .select({ value: max(draftVersions.versionNumber) })
        .from(draftVersions)
        .where(eq(draftVersions.draftId, params.draft.id));
      const [version] = await tx
        .insert(draftVersions)
        .values({
          id: versionId,
          draftId: params.draft.id,
          versionNumber: (numberRow?.value ?? 0) + 1,
          storageKey,
          contentSha256: params.version.contentSha256,
          contentType: params.version.contentType,
          originalFilename: params.version.originalFilename ?? "restored.html",
          sizeBytes: params.version.sizeBytes,
          totalSizeBytes: params.version.totalSizeBytes ?? params.version.sizeBytes,
          source: params.source,
          createdByTokenId: params.tokenId ?? null,
        })
        .returning();
      if (!version) throw new Error("Version insert returned no row");
      const [draft] = await tx
        .update(drafts)
        .set({ currentVersionId: version.id, updatedAt: sql`now()` })
        .where(eq(drafts.id, params.draft.id))
        .returning();
      if (!draft) throw new DraftNotFoundError();

      const keepVersions = retentionForKind(limits, locked.kind);
      const pruned =
        keepVersions === null
          ? []
          : await tx
              .select({ id: draftVersions.id })
              .from(draftVersions)
              .where(
                and(
                  eq(draftVersions.draftId, params.draft.id),
                  locked.kind === "html" ? eq(draftVersions.isBundle, false) : undefined,
                ),
              )
              .orderBy(desc(draftVersions.versionNumber))
              .offset(keepVersions);
      const prunedKeys = await listVersionStorageKeys(
        pruned.map((stale) => stale.id),
        tx,
      );
      for (const storageKey of prunedKeys) {
        await queueStorageDeletion({ storageKey, reason: "version_retention" }, tx);
      }
      if (pruned.length) {
        await tx.delete(draftVersions).where(
          inArray(
            draftVersions.id,
            pruned.map((row) => row.id),
          ),
        );
      }
      return { version, draft, pruned, prunedKeys };
    });
    for (const storageKey of result.prunedKeys) await tryDeleteStorageKey(storageKey);
    await recordAuditEvent({
      type: "draft.version_restored",
      userId: params.draft.ownerId,
      draftId: params.draft.id,
      tokenId: params.tokenId,
      metadata: {
        restoredFromVersion: params.version.versionNumber,
        versionNumber: result.version.versionNumber,
        sizeBytes: result.version.sizeBytes,
      },
    });
    return { version: result.version, draft: result.draft };
  } catch (error) {
    if (copied) {
      await getStorage()
        .delete(storageKey)
        .catch((cleanupError) =>
          console.error("Failed to clean up restored object", storageKey, cleanupError),
        );
    }
    throw error;
  }
}

export async function setDraftVisibility(
  draft: Draft,
  visibility: Visibility,
  actor: { userId: string; tokenId?: string },
  /** Required only when switching to "password" on a draft that has none set. */
  password?: string,
): Promise<Draft> {
  const db = getDb();

  if (visibility !== "password" && password !== undefined) {
    throw new PasswordVisibilityConflictError();
  }

  let passwordHash: string | null | undefined;
  if (visibility === "password") {
    if (password) {
      passwordHash = await hashPassword(password);
    } else if (!draft.passwordHash) {
      // No existing password and none supplied — cannot become password-protected.
      throw new PasswordRequiredError();
    }
    // else: keep the existing hash (passwordHash stays undefined = no change).
  } else {
    // Leaving password mode clears the stored hash.
    passwordHash = null;
  }

  const updated = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('agentplan:user-storage'), hashtext(${draft.ownerId}))`,
    );
    const [owner] = await tx
      .select({ blockedAt: users.blockedAt })
      .from(users)
      .where(eq(users.id, draft.ownerId))
      .for("update");
    if (!owner || owner.blockedAt) throw new DraftNotFoundError();
    const [result] = await tx
      .update(drafts)
      .set({
        visibility,
        ...(draft.visibility === "public" && visibility !== "public"
          ? { slug: generateSlug("", false) }
          : {}),
        ...(passwordHash !== undefined ? { passwordHash } : {}),
        updatedAt: sql`now()`,
      })
      .where(and(eq(drafts.id, draft.id), isNull(drafts.deletedAt)))
      .returning();
    if (!result) throw new DraftNotFoundError();
    return result;
  });
  await recordAuditEvent({
    type: "draft.visibility_changed",
    userId: actor.userId,
    draftId: draft.id,
    tokenId: actor.tokenId,
    metadata: { from: draft.visibility, to: visibility },
  });
  return updated;
}

/** Sets or changes a password and ensures the draft is password-protected. */
export async function setDraftPassword(
  draft: Draft,
  password: string,
  actor: { userId: string; tokenId?: string },
): Promise<Draft> {
  const db = getDb();
  const passwordHash = await hashPassword(password);
  const updated = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('agentplan:user-storage'), hashtext(${draft.ownerId}))`,
    );
    const [owner] = await tx
      .select({ blockedAt: users.blockedAt })
      .from(users)
      .where(eq(users.id, draft.ownerId))
      .for("update");
    if (!owner || owner.blockedAt) throw new DraftNotFoundError();
    const [result] = await tx
      .update(drafts)
      .set({
        visibility: "password",
        passwordHash,
        ...(draft.visibility === "public" ? { slug: generateSlug("", false) } : {}),
        updatedAt: sql`now()`,
      })
      .where(and(eq(drafts.id, draft.id), isNull(drafts.deletedAt)))
      .returning();
    if (!result) throw new DraftNotFoundError();
    return result;
  });
  await recordAuditEvent({
    type: "draft.visibility_changed",
    userId: actor.userId,
    draftId: draft.id,
    tokenId: actor.tokenId,
    metadata: { from: draft.visibility, to: "password", passwordChanged: true },
  });
  return updated;
}

export async function setDraftTitle(
  draft: Draft,
  title: string,
  actor: { userId: string; tokenId?: string },
): Promise<Draft> {
  const db = getDb();
  const updated = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('agentplan:user-storage'), hashtext(${draft.ownerId}))`,
    );
    const [owner] = await tx
      .select({ blockedAt: users.blockedAt })
      .from(users)
      .where(eq(users.id, draft.ownerId))
      .for("update");
    if (!owner || owner.blockedAt) throw new DraftNotFoundError();
    const [result] = await tx
      .update(drafts)
      .set({ title, updatedAt: sql`now()` })
      .where(and(eq(drafts.id, draft.id), isNull(drafts.deletedAt)))
      .returning();
    if (!result) throw new DraftNotFoundError();
    return result;
  });
  await recordAuditEvent({
    type: "draft.title_changed",
    userId: actor.userId,
    draftId: draft.id,
    tokenId: actor.tokenId,
    metadata: { from: draft.title, to: title },
  });
  return updated;
}

export async function softDeleteDraft(
  draft: Draft,
  actor: { userId: string; tokenId?: string },
): Promise<void> {
  const db = getDb();
  const cleanup = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('agentplan:user-storage'), hashtext(${draft.ownerId}))`,
    );
    const [owner] = await tx
      .select({ blockedAt: users.blockedAt })
      .from(users)
      .where(eq(users.id, draft.ownerId))
      .for("update");
    if (!owner || owner.blockedAt) throw new DraftNotFoundError();
    const [updated] = await tx
      .update(drafts)
      .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(drafts.id, draft.id), isNull(drafts.deletedAt)))
      .returning({ id: drafts.id });
    if (!updated) throw new DraftNotFoundError();
    const pending = await tx
      .update(uploadIntents)
      .set({ status: "cancelled", failureCode: "DRAFT_DELETED", updatedAt: sql`now()` })
      .where(and(eq(uploadIntents.targetDraftId, draft.id), eq(uploadIntents.status, "pending")))
      .returning();
    const keys: Array<{ storageKey: string; notBefore?: Date }> = [];
    for (const intent of pending) {
      if (intent.mode === "single") {
        if (intent.stagingKey) {
          keys.push({ storageKey: intent.stagingKey, notBefore: intent.expiresAt });
        }
        keys.push({ storageKey: intent.finalKey });
      } else {
        const files = await tx
          .select({ finalKey: uploadIntentFiles.finalKey })
          .from(uploadIntentFiles)
          .where(eq(uploadIntentFiles.intentId, intent.id));
        keys.push(
          ...[intent.finalKey, ...files.map((file) => file.finalKey)].map((storageKey) => ({
            storageKey,
            ...(intent.mode === "bundle" ? { notBefore: intent.expiresAt } : {}),
          })),
        );
      }
      await tx.delete(uploadIntentReclaims).where(eq(uploadIntentReclaims.intentId, intent.id));
    }
    for (const key of keys) {
      await queueStorageDeletion(
        {
          storageKey: key.storageKey,
          reason: "draft_deleted",
          notBefore: key.notBefore,
        },
        tx,
      );
    }
    return keys;
  });
  await Promise.all(cleanup.map((key) => tryDeleteStorageKey(key.storageKey)));
  await recordAuditEvent({
    type: "draft.deleted",
    userId: actor.userId,
    draftId: draft.id,
    tokenId: actor.tokenId,
    metadata: { slug: draft.slug },
  });
}
