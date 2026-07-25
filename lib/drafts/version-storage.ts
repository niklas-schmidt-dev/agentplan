import { inArray } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { draftVersionAssets, draftVersions } from "@/db/schema";

type ReadDb = Pick<Database, "select">;

/** Snapshot every private object owned by the supplied version rows. */
export async function listVersionStorageKeys(
  versionIds: readonly string[],
  db: ReadDb = getDb(),
): Promise<string[]> {
  if (versionIds.length === 0) return [];
  const entries = await db
    .select({ storageKey: draftVersions.storageKey })
    .from(draftVersions)
    .where(inArray(draftVersions.id, [...versionIds]));
  const assets = await db
    .select({ storageKey: draftVersionAssets.storageKey })
    .from(draftVersionAssets)
    .where(inArray(draftVersionAssets.versionId, [...versionIds]));
  return [...entries, ...assets].map((row) => row.storageKey);
}
