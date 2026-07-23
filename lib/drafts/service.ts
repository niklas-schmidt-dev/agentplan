import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  draftVersions,
  drafts,
  type Draft,
  type DraftVersion,
  type Visibility,
} from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit/events";
import { hashPassword } from "@/lib/drafts/password";
import { generateSlug } from "@/lib/drafts/slug";
import { consumeUploadRateLimit, lockAndAssertUploadQuota } from "@/lib/limits/enforce";
import { getStorage, storageKeyFor } from "@/lib/storage";

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
 * Upload flow: write bytes to private storage first, then commit metadata in
 * one transaction. If the transaction fails, try to remove the orphaned object.
 */
export async function createDraftWithFirstVersion(params: {
  ownerId: string;
  title: string;
  visibility: Visibility;
  bytes: Uint8Array;
  source: UploadSource;
  tokenId?: string;
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

  await consumeUploadRateLimit(params.ownerId);
  await getStorage().put(storageKey, params.bytes, HTML_CONTENT_TYPE);

  try {
    let lastError: unknown;
    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
      const slug = generateSlug(params.title);
      try {
        const result = await db.transaction(async (tx) => {
          await lockAndAssertUploadQuota(
            {
              userId: params.ownerId,
              sizeBytes: params.bytes.byteLength,
              newDraft: true,
            },
            tx,
          );
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
              sizeBytes: params.bytes.byteLength,
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
          metadata: { slug: result.draft.slug, visibility: params.visibility, sizeBytes: params.bytes.byteLength },
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
    await getStorage()
      .delete(storageKey)
      .catch((cleanupError) => console.error("Failed to clean up orphaned object", storageKey, cleanupError));
    throw error;
  }
}

export async function addVersionToDraft(params: {
  draft: Draft;
  bytes: Uint8Array;
  source: UploadSource;
  tokenId?: string;
  auditType?: "draft.version_created" | "draft.version_restored";
  auditMetadata?: Record<string, unknown>;
}): Promise<{ version: DraftVersion; draft: Draft }> {
  const db = getDb();
  const versionId = randomUUID();
  const storageKey = storageKeyFor(params.draft.ownerId, params.draft.id, versionId);
  const contentSha256 = sha256Hex(params.bytes);

  await consumeUploadRateLimit(params.draft.ownerId);
  await getStorage().put(storageKey, params.bytes, HTML_CONTENT_TYPE);

  try {
    const result = await db.transaction(async (tx) => {
      const limits = await lockAndAssertUploadQuota(
        {
          userId: params.draft.ownerId,
          sizeBytes: params.bytes.byteLength,
          newDraft: false,
        },
        tx,
      );
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
          sizeBytes: params.bytes.byteLength,
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
      let pruned: { id: string; storageKey: string }[] = [];
      if (limits.keepVersionsPerDraft !== null) {
        pruned = await tx
          .select({ id: draftVersions.id, storageKey: draftVersions.storageKey })
          .from(draftVersions)
          .where(eq(draftVersions.draftId, params.draft.id))
          .orderBy(desc(draftVersions.versionNumber))
          .offset(limits.keepVersionsPerDraft);
        if (pruned.length) {
          await tx.delete(draftVersions).where(
            inArray(
              draftVersions.id,
              pruned.map((p) => p.id),
            ),
          );
        }
      }
      return { version, draft: updatedDraft, pruned };
    });

    // Best-effort: the rows are already gone, so a failed delete strands one
    // small object with no reference. Logged and accepted — not worth a retry queue.
    for (const stale of result.pruned) {
      await getStorage()
        .delete(stale.storageKey)
        .catch((error) =>
          console.error("Failed to delete pruned version object", stale.storageKey, error),
        );
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
    await getStorage()
      .delete(storageKey)
      .catch((cleanupError) => console.error("Failed to clean up orphaned object", storageKey, cleanupError));
    throw error;
  }
}

/** Restore = new immutable version containing the restored bytes. */
export async function restoreVersion(params: {
  draft: Draft;
  version: DraftVersion;
  source: UploadSource;
  tokenId?: string;
}): Promise<{ version: DraftVersion; draft: Draft }> {
  const bytes = await getStorage().get(params.version.storageKey);
  if (!bytes) throw new Error("Stored content for this version is missing");
  return addVersionToDraft({
    draft: params.draft,
    bytes,
    source: params.source,
    tokenId: params.tokenId,
    auditType: "draft.version_restored",
    auditMetadata: { restoredFromVersion: params.version.versionNumber },
  });
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

  const [updated] = await db
    .update(drafts)
    .set({
      visibility,
      ...(passwordHash !== undefined ? { passwordHash } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(drafts.id, draft.id), isNull(drafts.deletedAt)))
    .returning();
  if (!updated) throw new DraftNotFoundError();
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
  const [updated] = await db
    .update(drafts)
    .set({ visibility: "password", passwordHash, updatedAt: sql`now()` })
    .where(and(eq(drafts.id, draft.id), isNull(drafts.deletedAt)))
    .returning();
  if (!updated) throw new DraftNotFoundError();
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
  const [updated] = await db
    .update(drafts)
    .set({ title, updatedAt: sql`now()` })
    .where(and(eq(drafts.id, draft.id), isNull(drafts.deletedAt)))
    .returning();
  if (!updated) throw new Error("Draft not found");
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
  await db
    .update(drafts)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(drafts.id, draft.id));
  await recordAuditEvent({
    type: "draft.deleted",
    userId: actor.userId,
    draftId: draft.id,
    tokenId: actor.tokenId,
    metadata: { slug: draft.slug },
  });
}
