import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { draftVersions, drafts, rateLimits } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit/events";
import { deletedDraftRetentionDays } from "@/lib/limits/plans";
import { getStorage } from "@/lib/storage";

export type PurgeResult = { purged: number; failed: number };

/**
 * Hard-deletes drafts that were soft-deleted longer than the retention window
 * ago, including their stored objects. Without this, delete/re-upload cycles
 * would grow storage forever while staying invisible to the storage quota
 * (which only counts live drafts). A draft's row is only removed once every
 * one of its objects is gone, so a storage hiccup retries on the next run.
 */
export async function purgeDeletedDrafts(batchSize = 100): Promise<PurgeResult> {
  const db = getDb();
  const retentionDays = deletedDraftRetentionDays();

  let purged = 0;
  let failed = 0;
  // Drain the whole backlog in batches; the offset skips rows whose object
  // deletion keeps failing so they can't starve the rest of a run. Each
  // iteration either purges rows or grows the offset, so this terminates.
  while (true) {
    const stale = await db
      .select({ id: drafts.id, slug: drafts.slug, ownerId: drafts.ownerId })
      .from(drafts)
      .where(
        and(
          isNotNull(drafts.deletedAt),
          lte(drafts.deletedAt, sql`now() - make_interval(days => ${retentionDays})`),
        ),
      )
      .orderBy(asc(drafts.deletedAt))
      .offset(failed)
      .limit(batchSize);
    if (stale.length === 0) break;

    for (const draft of stale) {
      const versions = await db
        .select({ storageKey: draftVersions.storageKey })
        .from(draftVersions)
        .where(eq(draftVersions.draftId, draft.id));

      let objectsFailed = false;
      for (const version of versions) {
        try {
          await getStorage().delete(version.storageKey);
        } catch (error) {
          objectsFailed = true;
          console.error("Failed to delete object during purge", version.storageKey, error);
        }
      }
      if (objectsFailed) {
        failed++;
        continue;
      }

      await db.delete(drafts).where(eq(drafts.id, draft.id));
      await recordAuditEvent({
        type: "draft.purged",
        userId: draft.ownerId,
        draftId: draft.id,
        metadata: { slug: draft.slug, versions: versions.length },
      });
      purged++;
    }
  }
  return { purged, failed };
}

/** Sweeps rate-limit windows the per-key opportunistic cleanup missed. */
export async function purgeExpiredRateLimits(): Promise<void> {
  await getDb().delete(rateLimits).where(lte(rateLimits.expiresAt, sql`now()`));
}
