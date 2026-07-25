import { and, asc, eq, lte, sql } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { storageDeletionJobs } from "@/db/schema";
import { getStorage } from "@/lib/storage";

type CleanupDb = Pick<Database, "insert">;

export async function queueStorageDeletion(
  input: { storageKey: string; reason: string; notBefore?: Date },
  db: CleanupDb = getDb(),
): Promise<void> {
  const notBefore = input.notBefore ?? new Date();
  await db
    .insert(storageDeletionJobs)
    .values({
      storageKey: input.storageKey,
      reason: input.reason.slice(0, 50),
      notBefore,
      nextAttemptAt: notBefore,
    })
    .onConflictDoUpdate({
      target: storageDeletionJobs.storageKey,
      set: {
        reason: input.reason.slice(0, 50),
        notBefore: sql`greatest(${storageDeletionJobs.notBefore}, ${notBefore})`,
        nextAttemptAt: sql`least(${storageDeletionJobs.nextAttemptAt}, ${notBefore})`,
        updatedAt: sql`now()`,
      },
    });
}

export async function tryDeleteStorageKey(storageKey: string): Promise<boolean> {
  try {
    await getStorage().delete(storageKey);
    const [job] = await getDb()
      .select({ notBefore: storageDeletionJobs.notBefore })
      .from(storageDeletionJobs)
      .where(eq(storageDeletionJobs.storageKey, storageKey))
      .limit(1);
    if (!job || job.notBefore.getTime() <= Date.now()) {
      await getDb()
        .delete(storageDeletionJobs)
        .where(eq(storageDeletionJobs.storageKey, storageKey));
    }
    return true;
  } catch (error) {
    await getDb()
      .update(storageDeletionJobs)
      .set({
        attempts: sql`${storageDeletionJobs.attempts} + 1`,
        lastError: error instanceof Error ? error.name.slice(0, 100) : "UnknownError",
        nextAttemptAt: sql`now() + interval '1 hour'`,
        updatedAt: sql`now()`,
      })
      .where(eq(storageDeletionJobs.storageKey, storageKey));
    console.error("Failed to delete queued storage object", storageKey, error);
    return false;
  }
}

export async function purgeStorageDeletionJobs(limit = 100): Promise<{
  purged: number;
  failed: number;
}> {
  const jobs = await getDb()
    .select({ storageKey: storageDeletionJobs.storageKey })
    .from(storageDeletionJobs)
    .where(
      and(
        lte(storageDeletionJobs.notBefore, sql`now()`),
        lte(storageDeletionJobs.nextAttemptAt, sql`now()`),
      ),
    )
    .orderBy(asc(storageDeletionJobs.createdAt))
    .limit(limit);
  let purged = 0;
  let failed = 0;
  for (const job of jobs) {
    if (await tryDeleteStorageKey(job.storageKey)) purged++;
    else failed++;
  }
  return { purged, failed };
}
