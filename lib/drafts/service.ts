import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, max, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  draftVersions,
  drafts,
  type Draft,
  type DraftVersion,
  type Visibility,
} from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit/events";
import { generateSlug } from "@/lib/drafts/slug";
import { getStorage, storageKeyFor } from "@/lib/storage";

export type UploadSource = "browser" | "api_token";

/** Thrown when a draft is soft-deleted mid-operation; callers map this to 404. */
export class DraftNotFoundError extends Error {
  constructor() {
    super("Draft not found");
    this.name = "DraftNotFoundError";
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
}): Promise<{ draft: Draft; version: DraftVersion }> {
  const db = getDb();
  const draftId = randomUUID();
  const versionId = randomUUID();
  const storageKey = storageKeyFor(params.ownerId, draftId, versionId);
  const contentSha256 = sha256Hex(params.bytes);

  await getStorage().put(storageKey, params.bytes, HTML_CONTENT_TYPE);

  try {
    let lastError: unknown;
    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
      const slug = generateSlug(params.title);
      try {
        const result = await db.transaction(async (tx) => {
          const [draft] = await tx
            .insert(drafts)
            .values({
              id: draftId,
              ownerId: params.ownerId,
              slug,
              title: params.title,
              visibility: params.visibility,
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

  await getStorage().put(storageKey, params.bytes, HTML_CONTENT_TYPE);

  try {
    const result = await db.transaction(async (tx) => {
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
      return { version, draft: updatedDraft };
    });

    await recordAuditEvent({
      type: params.auditType ?? "draft.version_created",
      userId: params.draft.ownerId,
      draftId: params.draft.id,
      tokenId: params.tokenId,
      metadata: {
        versionNumber: result.version.versionNumber,
        sizeBytes: params.bytes.byteLength,
        ...params.auditMetadata,
      },
    });
    return result;
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
): Promise<Draft> {
  const db = getDb();
  const [updated] = await db
    .update(drafts)
    .set({ visibility, updatedAt: sql`now()` })
    .where(and(eq(drafts.id, draft.id), isNull(drafts.deletedAt)))
    .returning();
  if (!updated) throw new Error("Draft not found");
  await recordAuditEvent({
    type: "draft.visibility_changed",
    userId: actor.userId,
    draftId: draft.id,
    tokenId: actor.tokenId,
    metadata: { from: draft.visibility, to: visibility },
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
