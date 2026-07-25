import { randomUUID } from "node:crypto";
import path from "node:path";
import { and, asc, count, desc, eq, gt, inArray, isNull, max, sql } from "drizzle-orm";
import {
  uploadSpecFor,
  validateBundleManifest,
  type BundleManifestFile,
} from "@agentplan/upload-contract";
import { getDb } from "@/db/client";
import {
  draftVersionAssets,
  draftVersions,
  drafts,
  uploadIntentFiles,
  uploadIntentReclaims,
  uploadIntents,
  users,
  type DraftVersion,
  type UploadIntent,
  type UploadIntentFile,
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
import { QuotaExceededError } from "@/lib/limits/errors";
import { lockAndAssertUploadQuota } from "@/lib/limits/enforce";
import {
  bundleAssetKeyFor,
  getStorage,
  resolveStorageDriver,
  storageKeyFor,
  type DirectUploadTarget,
} from "@/lib/storage";
import { queueStorageDeletion, tryDeleteStorageKey } from "@/lib/storage/cleanup";
import {
  consumeStoredObject,
  MediaValidationError,
  validateStoredMedia,
} from "@/lib/validation/media";
import { normalizeTitle, titleFromFilename } from "@/lib/validation/upload";
import {
  failUploadIntent,
  UploadIntentConflictError,
  UploadIntentExpiredError,
  UploadIntentNotFoundError,
  type UploadIntentResult,
} from "./service";
import { issueUploadIntentToken } from "./tokens";

const INTENT_TTL_MS = 60 * 60 * 1000;
const BUNDLE_RETENTION = 2;
const MAX_PENDING_BUNDLES = 10;
const TARGET_BATCH_SIZE = 10;

export type BundleTarget =
  | {
      type: "new";
      title?: string;
      visibility: Visibility;
      password?: string;
    }
  | { type: "draft"; draftId: string };

export type BundleFileDescriptor = {
  id: string;
  path: string;
  contentType: string;
  sizeBytes: number;
  uploaded?: boolean;
};

type BundleRow = {
  intent: UploadIntent;
  files: UploadIntentFile[];
};

function basename(logicalPath: string): string {
  return path.posix.basename(logicalPath).slice(0, 255);
}

function assertPendingBundle(intent: UploadIntent): void {
  if (intent.mode !== "bundle" && intent.mode !== "bundle_restore") {
    throw new UploadIntentConflictError("This upload is not an HTML bundle.");
  }
  if (intent.failureCode === "EXPIRED") throw new UploadIntentExpiredError();
  if (intent.status !== "pending") throw new UploadIntentConflictError();
  if (intent.expiresAt.getTime() <= Date.now()) throw new UploadIntentExpiredError();
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  task: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= values.length) return;
        result[index] = await task(values[index]!, index);
      }
    }),
  );
  return result;
}

export async function getBundleForOwner(
  ownerId: string,
  intentId: string,
): Promise<BundleRow | null> {
  const [intent] = await getDb()
    .select()
    .from(uploadIntents)
    .where(
      and(
        eq(uploadIntents.id, intentId),
        eq(uploadIntents.ownerId, ownerId),
        eq(uploadIntents.mode, "bundle"),
      ),
    )
    .limit(1);
  if (!intent) return null;
  const files = await getDb()
    .select()
    .from(uploadIntentFiles)
    .where(eq(uploadIntentFiles.intentId, intent.id))
    .orderBy(asc(uploadIntentFiles.logicalPath));
  return { intent, files };
}

function descriptors(bundle: BundleRow): BundleFileDescriptor[] {
  return [
    {
      id: bundle.intent.id,
      path: bundle.intent.entryPath ?? bundle.intent.originalFilename,
      contentType: bundle.intent.contentType,
      sizeBytes:
        bundle.intent.expectedBytes -
        bundle.files.reduce((total, file) => total + file.expectedBytes, 0),
    },
    ...bundle.files.map((file) => ({
      id: file.id,
      path: file.logicalPath,
      contentType: file.contentType,
      sizeBytes: file.expectedBytes,
    })),
  ];
}

export async function createBundleUpload(input: {
  ownerId: string;
  source: UploadSource;
  tokenId?: string;
  entryPath: string;
  files: BundleManifestFile[];
  target: BundleTarget;
}): Promise<{
  intent: UploadIntent;
  files: BundleFileDescriptor[];
  quota: {
    grossReservedBytes: number;
    plannedReclaimBytes: number;
    netGrowthBytes: number;
    willPruneVersions: number[];
  };
}> {
  let manifest: ReturnType<typeof validateBundleManifest>;
  try {
    manifest = validateBundleManifest({ entryPath: input.entryPath, files: input.files });
  } catch (error) {
    throw new MediaValidationError(
      "INVALID_FILE_TYPE",
      error instanceof Error ? error.message : "Invalid bundle manifest.",
    );
  }
  const entry = manifest.files.find((file) => file.path === manifest.entryPath)!;
  const assets = manifest.files.filter((file) => file.path !== manifest.entryPath);
  const intentId = randomUUID();
  const draftId = input.target.type === "draft" ? input.target.draftId : randomUUID();
  const versionId = randomUUID();
  const expiresAt = new Date(Date.now() + INTENT_TTL_MS);
  const finalKey = storageKeyFor(input.ownerId, draftId, versionId, ".html");
  const assetRows = assets.map((file) => {
    const id = randomUUID();
    return {
      id,
      path: file.path,
      contentType: file.contentType,
      expectedBytes: file.sizeBytes,
      originalFilename: basename(file.path),
      finalKey: bundleAssetKeyFor(
        input.ownerId,
        draftId,
        versionId,
        id,
        file.spec.canonicalExtension,
      ),
    };
  });

  let title: string | null = null;
  let visibility: Visibility | null = null;
  let passwordHash: string | null = null;
  if (input.target.type === "new") {
    title = normalizeTitle(input.target.title ?? titleFromFilename(entry.path));
    visibility = input.target.visibility;
    if (visibility === "password" && !input.target.password) throw new PasswordRequiredError();
    if (visibility !== "password" && input.target.password !== undefined) {
      throw new PasswordVisibilityConflictError();
    }
    passwordHash = visibility === "password" ? await hashPassword(input.target.password!) : null;
  }

  const created = await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('agentplan:user-storage'), hashtext(${input.ownerId}))`,
    );
    const [owner] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, input.ownerId), isNull(users.blockedAt)));
    if (!owner) throw new DraftNotFoundError();

    const [activeBundles] = await tx
      .select({ value: count() })
      .from(uploadIntents)
      .where(
        and(
          eq(uploadIntents.ownerId, input.ownerId),
          eq(uploadIntents.mode, "bundle"),
          eq(uploadIntents.status, "pending"),
          gt(uploadIntents.expiresAt, sql`now()`),
        ),
      );
    if ((activeBundles?.value ?? 0) >= MAX_PENDING_BUNDLES) {
      throw new UploadIntentConflictError(
        `At most ${MAX_PENDING_BUNDLES} bundle uploads can be pending at once.`,
      );
    }

    let existingVersions: Array<{
      id: string;
      versionNumber: number;
      isBundle: boolean;
      totalSizeBytes: number;
    }> = [];
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
      if (draft.kind !== "html") {
        throw new UploadIntentConflictError("Only HTML drafts accept bundle versions.");
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
      existingVersions = await tx
        .select({
          id: draftVersions.id,
          versionNumber: draftVersions.versionNumber,
          isBundle: draftVersions.isBundle,
          totalSizeBytes: sql<number>`coalesce(${draftVersions.totalSizeBytes}, ${draftVersions.sizeBytes})::int`,
        })
        .from(draftVersions)
        .where(eq(draftVersions.draftId, draft.id))
        .orderBy(desc(draftVersions.versionNumber));
    }

    const selected = new Map<string, (typeof existingVersions)[number]>();
    const bundleVersions = existingVersions.filter((version) => version.isBundle);
    for (const version of bundleVersions.slice(BUNDLE_RETENTION - 1)) {
      selected.set(version.id, version);
    }
    const oldestFirst = [...existingVersions].sort(
      (left, right) => left.versionNumber - right.versionNumber,
    );
    let cursor = 0;
    while (true) {
      const reclaimBytes = [...selected.values()].reduce(
        (total, version) => total + version.totalSizeBytes,
        0,
      );
      try {
        await lockAndAssertUploadQuota(
          {
            userId: input.ownerId,
            sizeBytes: manifest.totalBytes,
            newDraft: input.target.type === "new",
            reclaimBytes,
          },
          tx,
        );
        break;
      } catch (error) {
        if (!(error instanceof QuotaExceededError)) throw error;
        while (cursor < oldestFirst.length && selected.has(oldestFirst[cursor]!.id)) cursor++;
        const next = oldestFirst[cursor++];
        if (!next) throw error;
        selected.set(next.id, next);
      }
    }

    const [intent] = await tx
      .insert(uploadIntents)
      .values({
        id: intentId,
        ownerId: input.ownerId,
        targetDraftId: input.target.type === "draft" ? input.target.draftId : null,
        draftId,
        versionId,
        mode: "bundle",
        stagingKey: null,
        finalKey,
        kind: "html",
        originalFilename: basename(entry.path),
        contentType: "text/html",
        expectedBytes: manifest.totalBytes,
        entryPath: manifest.entryPath,
        fileCount: manifest.files.length,
        title,
        visibility,
        passwordHash,
        source: input.source,
        createdByTokenId: input.tokenId ?? null,
        expiresAt,
      })
      .returning();
    if (!intent) throw new Error("Bundle intent insert returned no row");

    if (assetRows.length) {
      await tx.insert(uploadIntentFiles).values(
        assetRows.map((file) => ({
          id: file.id,
          intentId: intent.id,
          logicalPath: file.path,
          finalKey: file.finalKey,
          contentType: file.contentType,
          originalFilename: file.originalFilename,
          expectedBytes: file.expectedBytes,
        })),
      );
    }
    const claims = [...selected.values()];
    if (claims.length) {
      await tx.insert(uploadIntentReclaims).values(
        claims.map((version) => ({
          intentId: intent.id,
          versionId: version.id,
          sizeBytes: version.totalSizeBytes,
        })),
      );
    }
    return { intent, claims };
  });

  return {
    intent: created.intent,
    files: [
      {
        id: created.intent.id,
        path: manifest.entryPath,
        contentType: "text/html",
        sizeBytes: entry.sizeBytes,
      },
      ...assetRows.map((file) => ({
        id: file.id,
        path: file.path,
        contentType: file.contentType,
        sizeBytes: file.expectedBytes,
      })),
    ],
    quota: {
      grossReservedBytes: manifest.totalBytes,
      plannedReclaimBytes: created.claims.reduce(
        (total, version) => total + version.totalSizeBytes,
        0,
      ),
      netGrowthBytes: Math.max(
        0,
        manifest.totalBytes -
          created.claims.reduce((total, version) => total + version.totalSizeBytes, 0),
      ),
      willPruneVersions: created.claims.map((version) => version.versionNumber),
    },
  };
}

export async function issueBundleUploadTargets(input: {
  ownerId: string;
  intentId: string;
  fileIds: string[];
  baseUrl: string;
}): Promise<
  Array<{
    fileId: string;
    uploaded: boolean;
    upload?: DirectUploadTarget;
  }>
> {
  if (input.fileIds.length < 1 || input.fileIds.length > TARGET_BATCH_SIZE) {
    throw new UploadIntentConflictError(
      `Request between 1 and ${TARGET_BATCH_SIZE} upload targets at a time.`,
    );
  }
  if (new Set(input.fileIds).size !== input.fileIds.length) {
    throw new UploadIntentConflictError("Upload target file IDs must be unique.");
  }
  const bundle = await getBundleForOwner(input.ownerId, input.intentId);
  if (!bundle) throw new UploadIntentNotFoundError();
  assertPendingBundle(bundle.intent);
  const allFiles = descriptors(bundle);
  const byId = new Map(allFiles.map((file) => [file.id, file]));
  const selected = input.fileIds.map((id) => {
    const file = byId.get(id);
    if (!file) throw new UploadIntentNotFoundError();
    return file;
  });
  const provider = resolveStorageDriver();
  return Promise.all(
    selected.map(async (file) => {
      const key =
        file.id === bundle.intent.id
          ? bundle.intent.finalKey
          : bundle.files.find((candidate) => candidate.id === file.id)!.finalKey;
      const existing = await getStorage().head(key);
      if (existing) {
        if (
          existing.size !== file.sizeBytes ||
          (existing.contentType &&
            existing.contentType.split(";")[0]?.trim().toLowerCase() !== file.contentType)
        ) {
          throw new UploadIntentConflictError(
            `An immutable object already exists with unexpected metadata: ${file.path}`,
          );
        }
        return { fileId: file.id, uploaded: true };
      }
      const token = issueUploadIntentToken({
        intentId: bundle.intent.id,
        ownerId: input.ownerId,
        stagingKey: key,
        provider,
        expiresAt: bundle.intent.expiresAt,
      });
      const localUploadUrl = new URL(
        `/api/v1/uploads/bundles/${bundle.intent.id}/files/${file.id}/body?token=${encodeURIComponent(token)}`,
        input.baseUrl,
      ).toString();
      const upload = await getStorage().createUploadTarget({
        key,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        expiresAt: bundle.intent.expiresAt,
        localUploadUrl,
      });
      return { fileId: file.id, uploaded: false, upload };
    }),
  );
}

export async function getBundleStatus(
  ownerId: string,
  intentId: string,
  includeStorageStatus = false,
): Promise<{
  intent: UploadIntent;
  files: BundleFileDescriptor[];
  draft?: typeof drafts.$inferSelect;
  version?: DraftVersion;
} | null> {
  const bundle = await getBundleForOwner(ownerId, intentId);
  if (!bundle) return null;
  let files = descriptors(bundle);
  if (includeStorageStatus && bundle.intent.status === "pending") {
    files = await mapWithConcurrency(files, 8, async (file) => {
      const key =
        file.id === bundle.intent.id
          ? bundle.intent.finalKey
          : bundle.files.find((candidate) => candidate.id === file.id)!.finalKey;
      const object = await getStorage().head(key);
      return { ...file, uploaded: object?.size === file.sizeBytes };
    });
  }
  if (bundle.intent.status !== "completed") return { intent: bundle.intent, files };
  const [[draft], [version]] = await Promise.all([
    getDb().select().from(drafts).where(eq(drafts.id, bundle.intent.draftId)).limit(1),
    getDb()
      .select()
      .from(draftVersions)
      .where(eq(draftVersions.id, bundle.intent.versionId))
      .limit(1),
  ]);
  return { intent: bundle.intent, files, draft, version };
}

export async function completeBundleUpload(
  intentId: string,
  ownerId: string,
): Promise<UploadIntentResult> {
  const bundle = await getBundleForOwner(ownerId, intentId);
  if (!bundle) throw new UploadIntentNotFoundError();
  if (bundle.intent.status === "completed") {
    const status = await getBundleStatus(ownerId, intentId);
    if (!status?.draft || !status.version) throw new Error("Completed bundle metadata is missing");
    return { intent: status.intent, draft: status.draft, version: status.version };
  }
  try {
    assertPendingBundle(bundle.intent);
  } catch (error) {
    if (error instanceof UploadIntentExpiredError) {
      await failUploadIntent(bundle.intent, "EXPIRED");
    }
    throw error;
  }

  const entryBytes =
    bundle.intent.expectedBytes -
    bundle.files.reduce((total, file) => total + file.expectedBytes, 0);
  const storageFiles = [
    {
      id: bundle.intent.id,
      logicalPath: bundle.intent.entryPath ?? bundle.intent.originalFilename,
      finalKey: bundle.intent.finalKey,
      contentType: bundle.intent.contentType,
      expectedBytes: entryBytes,
      originalFilename: bundle.intent.originalFilename,
    },
    ...bundle.files,
  ];

  try {
    const heads = await mapWithConcurrency(storageFiles, 8, async (file) => {
      const object = await getStorage().head(file.finalKey);
      if (!object || object.size !== file.expectedBytes) {
        throw new MediaValidationError(
          "SIZE_MISMATCH",
          `Stored bundle file does not match its reservation: ${file.logicalPath}`,
        );
      }
      if (
        object.contentType &&
        object.contentType.split(";")[0]?.trim().toLowerCase() !== file.contentType
      ) {
        throw new MediaValidationError(
          "INVALID_FILE_TYPE",
          `Stored content type does not match: ${file.logicalPath}`,
        );
      }
      return object;
    });
    void heads;

    const entryObject = await getStorage().open(bundle.intent.finalKey);
    if (!entryObject) throw new MediaValidationError("SIZE_MISMATCH", "HTML entry is missing.");
    const entryValidation = await consumeStoredObject(entryObject, entryBytes, false);

    const validatedAssets: Array<{
      file: UploadIntentFile;
      contentSha256: string;
      sizeBytes: number;
    }> = [];
    for (const file of bundle.files) {
      const spec = uploadSpecFor(file.logicalPath, file.contentType);
      if (!spec || spec.kind === "html") {
        throw new MediaValidationError("INVALID_FILE_TYPE", "Bundle asset metadata is invalid.");
      }
      const object = await getStorage().open(file.finalKey);
      if (!object) {
        throw new MediaValidationError(
          "SIZE_MISMATCH",
          `Bundle asset is missing: ${file.logicalPath}`,
        );
      }
      const validation = await validateStoredMedia({
        object,
        expectedBytes: file.expectedBytes,
        spec,
      });
      validatedAssets.push({ file, ...validation });
    }
    const totalSizeBytes =
      entryValidation.size + validatedAssets.reduce((total, asset) => total + asset.sizeBytes, 0);
    if (totalSizeBytes !== bundle.intent.expectedBytes) {
      throw new MediaValidationError(
        "SIZE_MISMATCH",
        "Bundle total does not match its reservation.",
      );
    }

    const result = await getDb().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('agentplan:user-storage'), hashtext(${bundle.intent.ownerId}))`,
      );
      const [lockedIntent] = await tx
        .select()
        .from(uploadIntents)
        .where(eq(uploadIntents.id, bundle.intent.id))
        .for("update");
      if (!lockedIntent) throw new UploadIntentNotFoundError();
      if (lockedIntent.status === "completed") {
        return { state: "already_completed" as const, completed: lockedIntent };
      }
      assertPendingBundle(lockedIntent);
      const [owner] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, lockedIntent.ownerId), isNull(users.blockedAt)));
      if (!owner) throw new DraftNotFoundError();
      const claims = await tx
        .select()
        .from(uploadIntentReclaims)
        .where(eq(uploadIntentReclaims.intentId, lockedIntent.id));
      const reclaimBytes = claims.reduce((total, claim) => total + claim.sizeBytes, 0);
      await lockAndAssertUploadQuota(
        {
          userId: lockedIntent.ownerId,
          sizeBytes: totalSizeBytes,
          newDraft: lockedIntent.targetDraftId === null,
          excludeIntentId: lockedIntent.id,
          reclaimBytes,
        },
        tx,
      );

      let draft;
      let versionNumber: number;
      if (lockedIntent.targetDraftId) {
        const [lockedDraft] = await tx
          .select()
          .from(drafts)
          .where(
            and(
              eq(drafts.id, lockedIntent.targetDraftId),
              eq(drafts.ownerId, lockedIntent.ownerId),
              isNull(drafts.deletedAt),
            ),
          )
          .for("update");
        if (!lockedDraft) throw new DraftNotFoundError();
        if (lockedDraft.kind !== "html") throw new UploadIntentConflictError();
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
            id: lockedIntent.draftId,
            ownerId: lockedIntent.ownerId,
            slug: generateSlug(lockedIntent.title ?? "", lockedIntent.visibility === "public"),
            title: lockedIntent.title ?? titleFromFilename(lockedIntent.originalFilename),
            kind: "html",
            visibility: lockedIntent.visibility ?? "private",
            passwordHash: lockedIntent.passwordHash,
          })
          .returning();
        if (!createdDraft) throw new Error("Draft insert returned no row");
        draft = createdDraft;
        versionNumber = 1;
      }

      const [version] = await tx
        .insert(draftVersions)
        .values({
          id: lockedIntent.versionId,
          draftId: draft.id,
          versionNumber,
          storageKey: lockedIntent.finalKey,
          contentSha256: entryValidation.sha256,
          contentType: "text/html",
          originalFilename: lockedIntent.originalFilename,
          sizeBytes: entryValidation.size,
          totalSizeBytes,
          entryPath: lockedIntent.entryPath,
          isBundle: true,
          source: lockedIntent.source,
          createdByTokenId: lockedIntent.createdByTokenId,
        })
        .returning();
      if (!version) throw new Error("Version insert returned no row");
      if (validatedAssets.length) {
        await tx.insert(draftVersionAssets).values(
          validatedAssets.map(({ file, contentSha256, sizeBytes }) => ({
            id: file.id,
            versionId: version.id,
            logicalPath: file.logicalPath,
            storageKey: file.finalKey,
            contentSha256,
            contentType: file.contentType,
            originalFilename: file.originalFilename,
            sizeBytes,
          })),
        );
      }
      const [updatedDraft] = await tx
        .update(drafts)
        .set({ currentVersionId: version.id, updatedAt: sql`now()` })
        .where(eq(drafts.id, draft.id))
        .returning();
      if (!updatedDraft) throw new DraftNotFoundError();

      const retainedBundles = await tx
        .select({ id: draftVersions.id })
        .from(draftVersions)
        .where(and(eq(draftVersions.draftId, draft.id), eq(draftVersions.isBundle, true)))
        .orderBy(desc(draftVersions.versionNumber))
        .offset(BUNDLE_RETENTION);
      const pruneIds = Array.from(
        new Set([
          ...claims.map((claim) => claim.versionId),
          ...retainedBundles.map((row) => row.id),
        ]),
      ).filter((id) => id !== version.id);
      let prunedKeys: string[] = [];
      if (pruneIds.length) {
        const entryKeys = await tx
          .select({ storageKey: draftVersions.storageKey })
          .from(draftVersions)
          .where(inArray(draftVersions.id, pruneIds));
        const assetKeys = await tx
          .select({ storageKey: draftVersionAssets.storageKey })
          .from(draftVersionAssets)
          .where(inArray(draftVersionAssets.versionId, pruneIds));
        prunedKeys = [...entryKeys, ...assetKeys].map((row) => row.storageKey);
        for (const storageKey of prunedKeys) {
          await queueStorageDeletion({ storageKey, reason: "version_retention" }, tx);
        }
      }
      await tx
        .delete(uploadIntentReclaims)
        .where(eq(uploadIntentReclaims.intentId, lockedIntent.id));
      if (pruneIds.length) {
        await tx.delete(draftVersions).where(inArray(draftVersions.id, pruneIds));
      }
      const [completed] = await tx
        .update(uploadIntents)
        .set({ status: "completed", completedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(uploadIntents.id, lockedIntent.id))
        .returning();
      if (!completed) throw new Error("Bundle intent update returned no row");
      return {
        state: "completed" as const,
        completed,
        draft: updatedDraft,
        version,
        prunedKeys,
        prunedVersions: pruneIds.length,
      };
    });

    if (result.state === "already_completed") {
      const status = await getBundleStatus(ownerId, intentId);
      if (!status?.draft || !status.version)
        throw new Error("Completed bundle metadata is missing");
      return { intent: status.intent, draft: status.draft, version: status.version };
    }
    await Promise.all(result.prunedKeys.map((key) => tryDeleteStorageKey(key)));
    await recordAuditEvent({
      type: bundle.intent.targetDraftId ? "draft.version_created" : "draft.created",
      userId: bundle.intent.ownerId,
      draftId: result.draft.id,
      tokenId: bundle.intent.createdByTokenId ?? undefined,
      metadata: {
        kind: "html",
        bundle: true,
        sizeBytes: totalSizeBytes,
        assetCount: validatedAssets.length,
        versionNumber: result.version.versionNumber,
        prunedVersions: result.prunedVersions,
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
        bundle.intent,
        error instanceof MediaValidationError ? error.code : error.name,
      );
    }
    throw error;
  }
}

export async function restoreBundleVersion(input: {
  ownerId: string;
  draftId: string;
  sourceVersionId: string;
  source: UploadSource;
  tokenId?: string;
}): Promise<{ draft: typeof drafts.$inferSelect; version: DraftVersion }> {
  const sourceVersion = await getDb()
    .select()
    .from(draftVersions)
    .where(
      and(
        eq(draftVersions.id, input.sourceVersionId),
        eq(draftVersions.draftId, input.draftId),
        eq(draftVersions.isBundle, true),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);
  if (!sourceVersion) throw new DraftNotFoundError();
  const sourceAssets = await getDb()
    .select()
    .from(draftVersionAssets)
    .where(eq(draftVersionAssets.versionId, sourceVersion.id))
    .orderBy(asc(draftVersionAssets.logicalPath));

  const intentId = randomUUID();
  const versionId = randomUUID();
  const expiresAt = new Date(Date.now() + INTENT_TTL_MS);
  const finalKey = storageKeyFor(input.ownerId, input.draftId, versionId, ".html");
  const destinationAssets = sourceAssets.map((asset) => {
    const id = randomUUID();
    const extension = path.posix.extname(asset.logicalPath);
    return {
      id,
      source: asset,
      finalKey: bundleAssetKeyFor(input.ownerId, input.draftId, versionId, id, extension),
    };
  });
  const totalSizeBytes = sourceVersion.totalSizeBytes ?? sourceVersion.sizeBytes;

  const intent = await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('agentplan:user-storage'), hashtext(${input.ownerId}))`,
    );
    const [owner] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, input.ownerId), isNull(users.blockedAt)));
    if (!owner) throw new DraftNotFoundError();
    const [draft] = await tx
      .select()
      .from(drafts)
      .where(
        and(
          eq(drafts.id, input.draftId),
          eq(drafts.ownerId, input.ownerId),
          isNull(drafts.deletedAt),
        ),
      )
      .for("update");
    if (!draft || draft.kind !== "html") throw new DraftNotFoundError();
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
    if (pending) throw new UploadIntentConflictError("Another upload is already pending.");
    const existingVersions = await tx
      .select({
        id: draftVersions.id,
        versionNumber: draftVersions.versionNumber,
        isBundle: draftVersions.isBundle,
        totalSizeBytes: sql<number>`coalesce(${draftVersions.totalSizeBytes}, ${draftVersions.sizeBytes})::int`,
      })
      .from(draftVersions)
      .where(eq(draftVersions.draftId, draft.id))
      .orderBy(desc(draftVersions.versionNumber));
    if (!existingVersions.some((version) => version.id === sourceVersion.id)) {
      throw new DraftNotFoundError();
    }

    const selected = new Map<string, (typeof existingVersions)[number]>();
    for (const version of existingVersions
      .filter((candidate) => candidate.isBundle)
      .slice(BUNDLE_RETENTION - 1)) {
      selected.set(version.id, version);
    }
    const oldestFirst = [...existingVersions].sort(
      (left, right) => left.versionNumber - right.versionNumber,
    );
    let cursor = 0;
    while (true) {
      const reclaimBytes = [...selected.values()].reduce(
        (total, version) => total + version.totalSizeBytes,
        0,
      );
      try {
        await lockAndAssertUploadQuota(
          {
            userId: input.ownerId,
            sizeBytes: totalSizeBytes,
            newDraft: false,
            reclaimBytes,
          },
          tx,
        );
        break;
      } catch (error) {
        if (!(error instanceof QuotaExceededError)) throw error;
        while (cursor < oldestFirst.length && selected.has(oldestFirst[cursor]!.id)) cursor++;
        const next = oldestFirst[cursor++];
        if (!next) throw error;
        selected.set(next.id, next);
      }
    }

    const [created] = await tx
      .insert(uploadIntents)
      .values({
        id: intentId,
        ownerId: input.ownerId,
        targetDraftId: input.draftId,
        draftId: input.draftId,
        versionId,
        mode: "bundle_restore",
        stagingKey: null,
        finalKey,
        kind: "html",
        originalFilename: sourceVersion.originalFilename ?? "restored.html",
        contentType: "text/html",
        expectedBytes: totalSizeBytes,
        entryPath: sourceVersion.entryPath ?? "index.html",
        fileCount: sourceAssets.length + 1,
        source: input.source,
        createdByTokenId: input.tokenId ?? null,
        expiresAt,
      })
      .returning();
    if (!created) throw new Error("Bundle restore intent insert returned no row");
    if (destinationAssets.length) {
      await tx.insert(uploadIntentFiles).values(
        destinationAssets.map(({ id, source, finalKey: assetFinalKey }) => ({
          id,
          intentId: created.id,
          logicalPath: source.logicalPath,
          finalKey: assetFinalKey,
          contentType: source.contentType,
          originalFilename: source.originalFilename,
          expectedBytes: source.sizeBytes,
          sourceKey: source.storageKey,
        })),
      );
    }
    const claims = [...selected.values()];
    if (claims.length) {
      await tx.insert(uploadIntentReclaims).values(
        claims.map((version) => ({
          intentId: created.id,
          versionId: version.id,
          sizeBytes: version.totalSizeBytes,
        })),
      );
    }
    return created;
  });

  try {
    await mapWithConcurrency(
      [
        {
          sourceKey: sourceVersion.storageKey,
          finalKey,
          contentType: "text/html",
        },
        ...destinationAssets.map((asset) => ({
          sourceKey: asset.source.storageKey,
          finalKey: asset.finalKey,
          contentType: asset.source.contentType,
        })),
      ],
      4,
      async (file) => {
        await getStorage().copy(file.sourceKey, file.finalKey, file.contentType);
      },
    );

    const copiedFiles = [
      {
        finalKey,
        sizeBytes: sourceVersion.sizeBytes,
        contentSha256: sourceVersion.contentSha256,
      },
      ...destinationAssets.map((asset) => ({
        finalKey: asset.finalKey,
        sizeBytes: asset.source.sizeBytes,
        contentSha256: asset.source.contentSha256,
      })),
    ];
    for (const file of copiedFiles) {
      const object = await getStorage().open(file.finalKey);
      if (!object) throw new MediaValidationError("SIZE_MISMATCH", "Restored object is missing.");
      const validated = await consumeStoredObject(object, file.sizeBytes, false);
      if (validated.sha256 !== file.contentSha256) {
        throw new MediaValidationError("INVALID_FILE_TYPE", "Restored object hash does not match.");
      }
    }

    const result = await getDb().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('agentplan:user-storage'), hashtext(${input.ownerId}))`,
      );
      const [lockedIntent] = await tx
        .select()
        .from(uploadIntents)
        .where(eq(uploadIntents.id, intent.id))
        .for("update");
      if (!lockedIntent) throw new UploadIntentNotFoundError();
      assertPendingBundle(lockedIntent);
      const [lockedDraft] = await tx
        .select()
        .from(drafts)
        .where(
          and(
            eq(drafts.id, input.draftId),
            eq(drafts.ownerId, input.ownerId),
            isNull(drafts.deletedAt),
          ),
        )
        .for("update");
      if (!lockedDraft) throw new DraftNotFoundError();
      const claims = await tx
        .select()
        .from(uploadIntentReclaims)
        .where(eq(uploadIntentReclaims.intentId, lockedIntent.id));
      const reclaimBytes = claims.reduce((sum, claim) => sum + claim.sizeBytes, 0);
      await lockAndAssertUploadQuota(
        {
          userId: input.ownerId,
          sizeBytes: totalSizeBytes,
          newDraft: false,
          excludeIntentId: lockedIntent.id,
          reclaimBytes,
        },
        tx,
      );
      const [sourceStillPresent] = await tx
        .select({ id: draftVersions.id })
        .from(draftVersions)
        .where(
          and(eq(draftVersions.id, sourceVersion.id), eq(draftVersions.draftId, lockedDraft.id)),
        );
      if (!sourceStillPresent) throw new DraftNotFoundError();
      const [numberRow] = await tx
        .select({ value: max(draftVersions.versionNumber) })
        .from(draftVersions)
        .where(eq(draftVersions.draftId, lockedDraft.id));
      const [version] = await tx
        .insert(draftVersions)
        .values({
          id: versionId,
          draftId: lockedDraft.id,
          versionNumber: (numberRow?.value ?? 0) + 1,
          storageKey: finalKey,
          contentSha256: sourceVersion.contentSha256,
          contentType: "text/html",
          originalFilename: sourceVersion.originalFilename,
          sizeBytes: sourceVersion.sizeBytes,
          totalSizeBytes,
          entryPath: sourceVersion.entryPath,
          isBundle: true,
          source: input.source,
          createdByTokenId: input.tokenId ?? null,
        })
        .returning();
      if (!version) throw new Error("Restored bundle version insert returned no row");
      if (destinationAssets.length) {
        await tx.insert(draftVersionAssets).values(
          destinationAssets.map((asset) => ({
            id: asset.id,
            versionId: version.id,
            logicalPath: asset.source.logicalPath,
            storageKey: asset.finalKey,
            contentSha256: asset.source.contentSha256,
            contentType: asset.source.contentType,
            originalFilename: asset.source.originalFilename,
            sizeBytes: asset.source.sizeBytes,
          })),
        );
      }
      const [updatedDraft] = await tx
        .update(drafts)
        .set({ currentVersionId: version.id, updatedAt: sql`now()` })
        .where(eq(drafts.id, lockedDraft.id))
        .returning();
      if (!updatedDraft) throw new DraftNotFoundError();
      const retainedBundles = await tx
        .select({ id: draftVersions.id })
        .from(draftVersions)
        .where(and(eq(draftVersions.draftId, lockedDraft.id), eq(draftVersions.isBundle, true)))
        .orderBy(desc(draftVersions.versionNumber))
        .offset(BUNDLE_RETENTION);
      const pruneIds = Array.from(
        new Set([
          ...claims.map((claim) => claim.versionId),
          ...retainedBundles.map((row) => row.id),
        ]),
      ).filter((id) => id !== version.id);
      const prunedKeys = await listVersionStorageKeys(pruneIds, tx);
      for (const storageKey of prunedKeys) {
        await queueStorageDeletion({ storageKey, reason: "version_retention" }, tx);
      }
      await tx
        .delete(uploadIntentReclaims)
        .where(eq(uploadIntentReclaims.intentId, lockedIntent.id));
      if (pruneIds.length) {
        await tx.delete(draftVersions).where(inArray(draftVersions.id, pruneIds));
      }
      await tx
        .update(uploadIntents)
        .set({ status: "completed", completedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(uploadIntents.id, lockedIntent.id));
      return { draft: updatedDraft, version, prunedKeys };
    });
    await Promise.all(result.prunedKeys.map(tryDeleteStorageKey));
    await recordAuditEvent({
      type: "draft.version_restored",
      userId: input.ownerId,
      draftId: input.draftId,
      tokenId: input.tokenId,
      metadata: {
        bundle: true,
        restoredFromVersion: sourceVersion.versionNumber,
        versionNumber: result.version.versionNumber,
        sizeBytes: totalSizeBytes,
        assetCount: sourceAssets.length,
      },
    });
    return { draft: result.draft, version: result.version };
  } catch (error) {
    await failUploadIntent(intent, error instanceof Error ? error.name : "RESTORE_FAILED");
    throw error;
  }
}
