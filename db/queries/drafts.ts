import { and, desc, eq, gte, ilike, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  draftVersionAssets,
  draftVersions,
  drafts,
  users,
  type Draft,
  type DraftVersion,
  type DraftVersionAsset,
  type Visibility,
} from "@/db/schema";

export async function getDraftBySlug(slug: string): Promise<Draft | null> {
  const [draft] = await getDb()
    .select({ draft: drafts })
    .from(drafts)
    .innerJoin(users, eq(drafts.ownerId, users.id))
    .where(and(eq(drafts.slug, slug), isNull(drafts.deletedAt), isNull(users.blockedAt)))
    .limit(1);
  return draft?.draft ?? null;
}

/** Owner-scoped lookup — the authorization decision lives in the query itself. */
export async function getDraftForOwner(draftId: string, ownerId: string): Promise<Draft | null> {
  const [draft] = await getDb()
    .select({ draft: drafts })
    .from(drafts)
    .innerJoin(users, eq(drafts.ownerId, users.id))
    .where(
      and(
        eq(drafts.id, draftId),
        eq(drafts.ownerId, ownerId),
        isNull(drafts.deletedAt),
        isNull(users.blockedAt),
      ),
    )
    .limit(1);
  return draft?.draft ?? null;
}

export type DraftListItem = Draft & {
  currentVersion: Pick<
    DraftVersion,
    "versionNumber" | "sizeBytes" | "contentSha256" | "isBundle"
  > | null;
};

export async function listDraftsForOwner(
  ownerId: string,
  filters: { search?: string; visibility?: Visibility; updatedWithinDays?: number } = {},
): Promise<DraftListItem[]> {
  const conditions = [
    eq(drafts.ownerId, ownerId),
    isNull(drafts.deletedAt),
    isNull(users.blockedAt),
  ];
  if (filters.visibility) conditions.push(eq(drafts.visibility, filters.visibility));
  if (filters.search) conditions.push(ilike(drafts.title, `%${filters.search}%`));
  if (filters.updatedWithinDays) {
    conditions.push(
      gte(drafts.updatedAt, sql`now() - make_interval(days => ${filters.updatedWithinDays})`),
    );
  }

  const rows = await getDb()
    .select({
      draft: drafts,
      versionNumber: draftVersions.versionNumber,
      sizeBytes: sql<number>`coalesce(${draftVersions.totalSizeBytes}, ${draftVersions.sizeBytes})::int`,
      contentSha256: draftVersions.contentSha256,
      isBundle: draftVersions.isBundle,
    })
    .from(drafts)
    .innerJoin(users, eq(drafts.ownerId, users.id))
    .leftJoin(draftVersions, eq(drafts.currentVersionId, draftVersions.id))
    .where(and(...conditions))
    .orderBy(desc(drafts.updatedAt))
    .limit(200);

  return rows.map((row) => ({
    ...row.draft,
    currentVersion:
      row.versionNumber === null
        ? null
        : {
            versionNumber: row.versionNumber,
            sizeBytes: row.sizeBytes ?? 0,
            contentSha256: row.contentSha256 ?? "",
            isBundle: row.isBundle ?? false,
          },
  }));
}

export async function getVersionById(
  draftId: string,
  versionId: string,
): Promise<DraftVersion | null> {
  const [version] = await getDb()
    .select()
    .from(draftVersions)
    .where(and(eq(draftVersions.id, versionId), eq(draftVersions.draftId, draftId)))
    .limit(1);
  return version ?? null;
}

export async function listVersions(draftId: string): Promise<DraftVersion[]> {
  return getDb()
    .select()
    .from(draftVersions)
    .where(eq(draftVersions.draftId, draftId))
    .orderBy(desc(draftVersions.versionNumber));
}

export async function getVersionAsset(
  versionId: string,
  logicalPath: string,
): Promise<DraftVersionAsset | null> {
  const [asset] = await getDb()
    .select()
    .from(draftVersionAssets)
    .where(
      and(
        eq(draftVersionAssets.versionId, versionId),
        eq(draftVersionAssets.logicalPath, logicalPath),
      ),
    )
    .limit(1);
  return asset ?? null;
}
