import { cancelDraftUploads } from "@/lib/drafts/upload-cleanup";
import { and, asc, eq, isNotNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { draftVersions, drafts, rateLimits } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit/events";
import { listVersionStorageKeys } from "@/lib/drafts/version-storage";
import { deletedDraftRetentionDays } from "@/lib/limits/plans";
import { getStorage } from "@/lib/storage";

export type PurgeResult = { purged: number; failed: number };

/**
 * Hard-deletes expired drafts and drafts soft-deleted beyond the retention
 * window, including every version and its stored objects. Without this, delete/re-upload cycles
 * would grow storage forever while staying invisible to the storage quota
 * (which only counts live drafts). A draft's row is only removed once every
 * one of its objects is gone, so a storage hiccup retries on the next run.
 */
export async function purgeDeletedDrafts(
  batchSize = 100,
  deadline = Date.now() + 30_000,
): Promise<PurgeResult> {
  const db = getDb();
  const retentionDays = deletedDraftRetentionDays();
  // User-selected expiry bypasses the ordinary soft-delete retention window.
  const due = or(
    and(
      isNotNull(drafts.deletedAt),
      lte(drafts.deletedAt, sql`now() - make_interval(days => ${retentionDays})`),
    ),
    lte(drafts.expiresAt, sql`clock_timestamp()`),
  )!;

  let purged = 0;
  let failed = 0;
  // Drain the whole backlog in batches; the offset skips rows whose object
  // deletion keeps failing so they can't starve the rest of a run. Each
  // iteration either purges rows or grows the offset, so this terminates.
  while (Date.now() < deadline) {
    const stale = await db
      .select({ id: drafts.id, slug: drafts.slug, ownerId: drafts.ownerId })
      .from(drafts)
      .where(due)
      .orderBy(asc(drafts.deletedAt), asc(drafts.id))
      .offset(failed)
      .limit(batchSize);
    if (stale.length === 0) break;

    for (const draft of stale) {
      if (Date.now() >= deadline) break;
      // Serialize against uploads and account deletion before taking the object
      // inventory. Persist the tombstone and delayed pending-upload cleanup first,
      // so a crash or an in-flight transfer cannot resurrect an expired draft.
      const snapshot = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext('agentplan:user-storage'), hashtext(${draft.ownerId}))`,
        );
        const [locked] = await tx
          .select({ id: drafts.id })
          .from(drafts)
          .where(and(eq(drafts.id, draft.id), due))
          .for("update");
        if (!locked) return null;
        await tx
          .update(drafts)
          .set({ deletedAt: sql`coalesce(${drafts.deletedAt}, ${drafts.expiresAt})` })
          .where(eq(drafts.id, draft.id));
        await cancelDraftUploads(tx, draft.id);
        const versions = await tx
          .select({ id: draftVersions.id })
          .from(draftVersions)
          .where(eq(draftVersions.draftId, draft.id));
        const storageKeys = await listVersionStorageKeys(
          versions.map((version) => version.id),
          tx,
        );
        return { versions, storageKeys };
      });
      if (!snapshot) continue;
      const { versions, storageKeys } = snapshot;

      let objectsFailed = false;
      for (const storageKey of storageKeys) {
        try {
          await getStorage().delete(storageKey);
        } catch (error) {
          objectsFailed = true;
          console.error("Failed to delete object during purge", storageKey, error);
        }
      }
      if (objectsFailed) {
        failed++;
        continue;
      }

      try {
        await db.delete(drafts).where(eq(drafts.id, draft.id));
      } catch (error) {
        failed++;
        console.error("Failed to delete draft row during purge", draft.id, error);
        continue;
      }
      await recordAuditEvent({
        type: "draft.purged",
        userId: draft.ownerId,
        draftId: draft.id,
        metadata: { slug: draft.slug, versions: versions.length, objects: storageKeys.length },
      }).catch((error) =>
        console.error("Failed to record draft purge audit event", draft.id, error),
      );
      purged++;
    }
  }
  return { purged, failed };
}

/** Sweeps rate-limit windows the per-key opportunistic cleanup missed. */
export async function purgeExpiredRateLimits(): Promise<void> {
  await getDb()
    .delete(rateLimits)
    .where(lte(rateLimits.expiresAt, sql`now()`));
}
