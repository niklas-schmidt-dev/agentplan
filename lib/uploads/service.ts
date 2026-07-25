import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, max, sql } from "drizzle-orm";
import { uploadSpecFor, type UploadKind, type UploadSpec } from "@agentplan/upload-contract";
import { getDb, type Database } from "@/db/client";
import {
  draftVersions,
  drafts,
  uploadIntentFiles,
  uploadIntentReclaims,
  uploadIntents,
  users,
  type UploadIntent,
  type Visibility,
} from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit/events";
import { hashPassword } from "@/lib/drafts/password";
import { generateSlug } from "@/lib/drafts/slug";
import { listVersionStorageKeys } from "@/lib/drafts/version-storage";
import {
  DraftNotFoundError,
  PasswordRequiredError,
  PasswordVisibilityConflictError,
  type UploadSource,
} from "@/lib/drafts/service";
import { lockAndAssertUploadQuota } from "@/lib/limits/enforce";
import { retentionForKind } from "@/lib/limits/plans";
import {
  getStorage,
  resolveStorageDriver,
  stagingKeyFor,
  storageKeyFor,
  type DirectUploadTarget,
} from "@/lib/storage";
import { queueStorageDeletion, tryDeleteStorageKey } from "@/lib/storage/cleanup";
import {
  MediaValidationError,
  validateDirectUploadMetadata,
  validateStoredMedia,
} from "@/lib/validation/media";
import { normalizeTitle, titleFromFilename } from "@/lib/validation/upload";
import { issueUploadIntentToken } from "./tokens";

const INTENT_TTL_MS = 60 * 60 * 1000;

export class UploadIntentNotFoundError extends Error {}
export class UploadIntentExpiredError extends Error {}
export class UploadIntentConflictError extends Error {}

export type UploadIntentResult = {
  intent: UploadIntent;
  draft: typeof drafts.$inferSelect;
  version: typeof draftVersions.$inferSelect;
};

function specForIntent(intent: UploadIntent): UploadSpec {
  if (intent.mode !== "single") {
    throw new MediaValidationError("INVALID_FILE_TYPE", "Expected a single-file upload intent.");
  }
  const spec = uploadSpecFor(intent.originalFilename, intent.contentType);
  if (!spec || spec.kind !== intent.kind || spec.kind === "html") {
    throw new MediaValidationError("INVALID_FILE_TYPE", "Upload metadata is invalid.");
  }
  return spec;
}

export async function createUploadIntent(input: {
  ownerId: string;
  source: UploadSource;
  tokenId?: string;
  filename: string;
  contentType: string | null;
  sizeBytes: number;
  target:
    | {
        type: "new";
        title?: string;
        visibility: Visibility;
        password?: string;
      }
    | { type: "draft"; draftId: string };
  baseUrl: string;
}): Promise<{ intent: UploadIntent; upload: DirectUploadTarget }> {
  const spec = validateDirectUploadMetadata(input);
  const intentId = randomUUID();
  const draftId = input.target.type === "draft" ? input.target.draftId : randomUUID();
  const versionId = randomUUID();
  const expiresAt = new Date(Date.now() + INTENT_TTL_MS);
  const stagingKey = stagingKeyFor(input.ownerId, intentId, spec.canonicalExtension);
  const finalKey = storageKeyFor(input.ownerId, draftId, versionId, spec.canonicalExtension);

  let title: string | null = null;
  let visibility: Visibility | null = null;
  let passwordHash: string | null = null;
  if (input.target.type === "new") {
    title = normalizeTitle(input.target.title ?? titleFromFilename(input.filename));
    visibility = input.target.visibility;
    if (visibility === "password" && !input.target.password) throw new PasswordRequiredError();
    if (visibility !== "password" && input.target.password !== undefined) {
      throw new PasswordVisibilityConflictError();
    }
    passwordHash = visibility === "password" ? await hashPassword(input.target.password!) : null;
  }

  const intent = await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('agentplan:user-storage'), hashtext(${input.ownerId}))`,
    );
    const [owner] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, input.ownerId), isNull(users.blockedAt)));
    if (!owner) throw new DraftNotFoundError();

    if (input.target.type === "draft") {
      const [draft] = await tx
        .select({ id: drafts.id, kind: drafts.kind })
        .from(drafts)
        .where(
          and(
            eq(drafts.id, input.target.draftId),
            eq(drafts.ownerId, input.ownerId),
            isNull(drafts.deletedAt),
          ),
        )
        .for("update");
      if (!draft) throw new DraftNotFoundError();
      if (draft.kind !== spec.kind) {
        throw new UploadIntentConflictError("A draft cannot change file kind.");
      }
      const [pending] = await tx
        .select({ id: uploadIntents.id })
        .from(uploadIntents)
        .where(
          and(
            eq(uploadIntents.targetDraftId, draft.id),
            eq(uploadIntents.status, "pending"),
            gt(uploadIntents.expiresAt, sql`now()`),
          ),
        )
        .limit(1);
      if (pending) {
        throw new UploadIntentConflictError("Another upload is already pending for this draft.");
      }
    }

    await lockAndAssertUploadQuota(
      {
        userId: input.ownerId,
        sizeBytes: input.sizeBytes,
        newDraft: input.target.type === "new",
      },
      tx,
    );
    const [created] = await tx
      .insert(uploadIntents)
      .values({
        id: intentId,
        ownerId: input.ownerId,
        targetDraftId: input.target.type === "draft" ? input.target.draftId : null,
        draftId,
        versionId,
        stagingKey,
        finalKey,
        kind: spec.kind,
        originalFilename: input.filename.slice(0, 255),
        contentType: spec.contentType,
        expectedBytes: input.sizeBytes,
        title,
        visibility,
        passwordHash,
        source: input.source,
        createdByTokenId: input.tokenId ?? null,
        expiresAt,
      })
      .returning();
    if (!created) throw new Error("Upload intent insert returned no row");
    return created;
  });

  const provider = resolveStorageDriver();
  const token = issueUploadIntentToken({
    intentId,
    ownerId: input.ownerId,
    stagingKey,
    provider,
    expiresAt,
  });
  try {
    const callbackUrl = new URL("/api/v1/uploads/vercel-callback", input.baseUrl).toString();
    const localUploadUrl = new URL(
      `/api/v1/uploads/intents/${intentId}/body?token=${encodeURIComponent(token)}`,
      input.baseUrl,
    ).toString();
    const upload = await getStorage().createUploadTarget({
      key: stagingKey,
      contentType: spec.contentType,
      sizeBytes: input.sizeBytes,
      expiresAt,
      callbackUrl: provider === "vercel-blob" ? callbackUrl : undefined,
      callbackPayload: provider === "vercel-blob" ? token : undefined,
      localUploadUrl,
    });
    return { intent, upload };
  } catch (error) {
    await failUploadIntent(intent, "UPLOAD_TARGET_FAILED");
    throw error;
  }
}

export async function listPendingUploadIntents(ownerId: string): Promise<UploadIntent[]> {
  return getDb()
    .select()
    .from(uploadIntents)
    .where(
      and(
        eq(uploadIntents.ownerId, ownerId),
        eq(uploadIntents.status, "pending"),
        gt(uploadIntents.expiresAt, sql`now()`),
      ),
    )
    .orderBy(desc(uploadIntents.createdAt));
}

export async function getUploadIntentForOwner(
  ownerId: string,
  intentId: string,
): Promise<UploadIntent | null> {
  const [intent] = await getDb()
    .select()
    .from(uploadIntents)
    .where(and(eq(uploadIntents.id, intentId), eq(uploadIntents.ownerId, ownerId)))
    .limit(1);
  return intent ?? null;
}

async function completedResult(intent: UploadIntent): Promise<UploadIntentResult> {
  const [[draft], [version]] = await Promise.all([
    getDb().select().from(drafts).where(eq(drafts.id, intent.draftId)).limit(1),
    getDb().select().from(draftVersions).where(eq(draftVersions.id, intent.versionId)).limit(1),
  ]);
  if (!draft || !version) throw new Error("Completed upload metadata is missing");
  return { intent, draft, version };
}

async function ensureFinalCopy(intent: UploadIntent): Promise<void> {
  if (!intent.stagingKey) throw new UploadIntentConflictError("Upload staging key is missing.");
  if (await getStorage().head(intent.finalKey)) return;
  try {
    await getStorage().copy(intent.stagingKey, intent.finalKey, intent.contentType);
  } catch (error) {
    if (!(await getStorage().head(intent.finalKey))) throw error;
  }
}

export async function cleanupKeysForIntent(
  intent: UploadIntent,
  db: Pick<Database, "select"> = getDb(),
): Promise<Array<{ storageKey: string; notBefore?: Date }>> {
  if (intent.mode === "single") {
    return [
      ...(intent.stagingKey
        ? [{ storageKey: intent.stagingKey, notBefore: intent.expiresAt }]
        : []),
      { storageKey: intent.finalKey },
    ];
  }
  const files = await db
    .select({ finalKey: uploadIntentFiles.finalKey })
    .from(uploadIntentFiles)
    .where(eq(uploadIntentFiles.intentId, intent.id));
  return [intent.finalKey, ...files.map((file) => file.finalKey)].map((storageKey) => ({
    storageKey,
    // Uploaded bundle keys were exposed by a capability. Restore destinations
    // are server-created and can be removed immediately.
    ...(intent.mode === "bundle" ? { notBefore: intent.expiresAt } : {}),
  }));
}

export async function failUploadIntent(intent: UploadIntent, failureCode: string): Promise<void> {
  const cleanup = await cleanupKeysForIntent(intent);
  const transitioned = await getDb().transaction(async (tx) => {
    const [failed] = await tx
      .update(uploadIntents)
      .set({ status: "failed", failureCode: failureCode.slice(0, 50), updatedAt: sql`now()` })
      .where(and(eq(uploadIntents.id, intent.id), eq(uploadIntents.status, "pending")))
      .returning({ id: uploadIntents.id });
    if (!failed) return false;
    await tx.delete(uploadIntentReclaims).where(eq(uploadIntentReclaims.intentId, intent.id));
    for (const key of cleanup) {
      await queueStorageDeletion(
        {
          storageKey: key.storageKey,
          reason: "upload_intent_failed",
          notBefore: key.notBefore,
        },
        tx,
      );
    }
    return true;
  });
  if (transitioned) {
    await Promise.all(cleanup.map((key) => tryDeleteStorageKey(key.storageKey)));
  }
}

export async function completeUploadIntent(
  intentId: string,
  ownerId?: string,
): Promise<UploadIntentResult> {
  const [intent] = await getDb()
    .select()
    .from(uploadIntents)
    .where(
      ownerId
        ? and(eq(uploadIntents.id, intentId), eq(uploadIntents.ownerId, ownerId))
        : eq(uploadIntents.id, intentId),
    )
    .limit(1);
  if (!intent) throw new UploadIntentNotFoundError();
  if (intent.mode !== "single") {
    throw new UploadIntentConflictError("Use the bundle completion endpoint for this upload.");
  }
  if (intent.status === "completed") return completedResult(intent);
  if (intent.failureCode === "EXPIRED") throw new UploadIntentExpiredError();
  if (intent.status !== "pending") throw new UploadIntentConflictError();
  if (intent.expiresAt.getTime() <= Date.now()) {
    await failUploadIntent(intent, "EXPIRED");
    throw new UploadIntentExpiredError();
  }

  try {
    if (!intent.stagingKey) throw new UploadIntentConflictError("Upload staging key is missing.");
    const stagingKey = intent.stagingKey;
    const staging = await getStorage().head(stagingKey);
    if (!staging) throw new MediaValidationError("SIZE_MISMATCH", "Uploaded object is missing.");
    if (staging.size !== intent.expectedBytes) {
      throw new MediaValidationError("SIZE_MISMATCH", "Stored file size does not match.");
    }
    await ensureFinalCopy(intent);
    const finalObject = await getStorage().open(intent.finalKey);
    if (!finalObject) throw new MediaValidationError("SIZE_MISMATCH", "Final object is missing.");
    const validation = await validateStoredMedia({
      object: finalObject,
      expectedBytes: intent.expectedBytes,
      spec: specForIntent(intent),
    });

    const result = await getDb().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('agentplan:user-storage'), hashtext(${intent.ownerId}))`,
      );
      const [lockedIntent] = await tx
        .select()
        .from(uploadIntents)
        .where(eq(uploadIntents.id, intent.id))
        .for("update");
      if (!lockedIntent) throw new UploadIntentNotFoundError();
      if (lockedIntent.status === "completed") {
        return { state: "already_completed" as const, completed: lockedIntent };
      }
      if (lockedIntent.status !== "pending") throw new UploadIntentConflictError();
      if (lockedIntent.expiresAt.getTime() <= Date.now()) throw new UploadIntentExpiredError();
      const [owner] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, intent.ownerId), isNull(users.blockedAt)));
      if (!owner) throw new DraftNotFoundError();

      const limits = await lockAndAssertUploadQuota(
        {
          userId: intent.ownerId,
          sizeBytes: validation.sizeBytes,
          newDraft: intent.targetDraftId === null,
          excludeIntentId: intent.id,
        },
        tx,
      );

      let draft;
      let versionNumber: number;
      if (intent.targetDraftId) {
        const [lockedDraft] = await tx
          .select()
          .from(drafts)
          .where(
            and(
              eq(drafts.id, intent.targetDraftId),
              eq(drafts.ownerId, intent.ownerId),
              isNull(drafts.deletedAt),
            ),
          )
          .for("update");
        if (!lockedDraft) throw new DraftNotFoundError();
        if (lockedDraft.kind !== intent.kind) throw new UploadIntentConflictError();
        const [numberRow] = await tx
          .select({ value: max(draftVersions.versionNumber) })
          .from(draftVersions)
          .where(eq(draftVersions.draftId, lockedDraft.id));
        versionNumber = (numberRow?.value ?? 0) + 1;
        draft = lockedDraft;
      } else {
        const [createdDraft] = await tx
          .insert(drafts)
          .values({
            id: intent.draftId,
            ownerId: intent.ownerId,
            slug: generateSlug(intent.title ?? "", intent.visibility === "public"),
            title: intent.title ?? titleFromFilename(intent.originalFilename),
            kind: intent.kind,
            visibility: intent.visibility ?? "private",
            passwordHash: intent.passwordHash,
          })
          .returning();
        if (!createdDraft) throw new Error("Draft insert returned no row");
        draft = createdDraft;
        versionNumber = 1;
      }

      const [version] = await tx
        .insert(draftVersions)
        .values({
          id: intent.versionId,
          draftId: draft.id,
          versionNumber,
          storageKey: intent.finalKey,
          contentSha256: validation.contentSha256,
          contentType: intent.contentType,
          originalFilename: intent.originalFilename,
          sizeBytes: validation.sizeBytes,
          totalSizeBytes: validation.sizeBytes,
          source: intent.source,
          createdByTokenId: intent.createdByTokenId,
        })
        .returning();
      if (!version) throw new Error("Version insert returned no row");

      const [updatedDraft] = await tx
        .update(drafts)
        .set({ currentVersionId: version.id, updatedAt: sql`now()` })
        .where(eq(drafts.id, draft.id))
        .returning();
      if (!updatedDraft) throw new DraftNotFoundError();

      const keepVersions = retentionForKind(limits, intent.kind);
      const pruned =
        keepVersions === null
          ? []
          : await tx
              .select({ id: draftVersions.id })
              .from(draftVersions)
              .where(eq(draftVersions.draftId, draft.id))
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
      await queueStorageDeletion(
        {
          storageKey: stagingKey,
          reason: "upload_staging",
          notBefore: intent.expiresAt,
        },
        tx,
      );
      const [completed] = await tx
        .update(uploadIntents)
        .set({ status: "completed", completedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(uploadIntents.id, intent.id))
        .returning();
      if (!completed) throw new Error("Upload intent update returned no row");
      return {
        state: "completed" as const,
        completed,
        draft: updatedDraft,
        version,
        pruned,
        prunedKeys,
      };
    });

    if (result.state === "already_completed") return completedResult(result.completed);
    await tryDeleteStorageKey(stagingKey);
    for (const storageKey of result.prunedKeys) await tryDeleteStorageKey(storageKey);
    await recordAuditEvent({
      type: intent.targetDraftId ? "draft.version_created" : "draft.created",
      userId: intent.ownerId,
      draftId: result.draft.id,
      tokenId: intent.createdByTokenId ?? undefined,
      metadata: {
        kind: intent.kind,
        sizeBytes: validation.sizeBytes,
        versionNumber: result.version.versionNumber,
      },
    });
    return { intent: result.completed, draft: result.draft, version: result.version };
  } catch (error) {
    if (
      error instanceof MediaValidationError ||
      error instanceof DraftNotFoundError ||
      error instanceof UploadIntentExpiredError
    ) {
      await failUploadIntent(
        intent,
        error instanceof MediaValidationError ? error.code : error.name,
      );
    }
    throw error;
  }
}

export async function cancelUploadIntent(ownerId: string, intentId: string): Promise<void> {
  const intent = await getUploadIntentForOwner(ownerId, intentId);
  if (!intent) throw new UploadIntentNotFoundError();
  if (intent.status === "completed") throw new UploadIntentConflictError();
  if (intent.status !== "pending") return;
  const cleanup = await cleanupKeysForIntent(intent);
  const transitioned = await getDb().transaction(async (tx) => {
    const [cancelled] = await tx
      .update(uploadIntents)
      .set({ status: "cancelled", updatedAt: sql`now()` })
      .where(and(eq(uploadIntents.id, intent.id), eq(uploadIntents.status, "pending")))
      .returning({ id: uploadIntents.id });
    if (!cancelled) return false;
    await tx.delete(uploadIntentReclaims).where(eq(uploadIntentReclaims.intentId, intent.id));
    for (const key of cleanup) {
      await queueStorageDeletion(
        {
          storageKey: key.storageKey,
          reason: "upload_cancelled",
          notBefore: key.notBefore,
        },
        tx,
      );
    }
    return true;
  });
  if (transitioned) {
    await Promise.all(cleanup.map((key) => tryDeleteStorageKey(key.storageKey)));
  }
}

export async function purgeExpiredUploadIntents(): Promise<number> {
  const expired = await getDb()
    .select()
    .from(uploadIntents)
    .where(and(eq(uploadIntents.status, "pending"), sql`${uploadIntents.expiresAt} <= now()`))
    .limit(100);
  for (const intent of expired) await failUploadIntent(intent, "EXPIRED");
  await getDb()
    .delete(uploadIntents)
    .where(
      and(
        inArray(uploadIntents.status, ["completed", "cancelled", "failed"]),
        sql`${uploadIntents.updatedAt} < now() - interval '7 days'`,
      ),
    );
  return expired.length;
}

export function kindLabel(kind: UploadKind): string {
  return kind === "html" ? "HTML" : kind === "image" ? "image" : "video";
}
