import { decodeDraftCursor, draftFilterKey, encodeDraftCursor } from "@/lib/api/draft-cursor";
import { and, asc, desc, eq, gte, ilike, isNull, sql } from "drizzle-orm";
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

export type DraftListFilters = {
  search?: string;
  visibility?: Visibility;
  updatedWithinDays?: number;
  limit?: number;
  cursor?: string;
};

export async function listDraftsForOwner(
  ownerId: string,
  filters: DraftListFilters = {},
): Promise<DraftListItem[]> {
  return (await listDraftsPageForOwner(ownerId, filters)).drafts;
}

export async function listDraftsPageForOwner(
  ownerId: string,
  filters: DraftListFilters = {},
): Promise<{
  drafts: DraftListItem[];
  nextCursor: string | null;
  previousCursor: string | null;
}> {
  const limit = Math.min(200, Math.max(1, Math.trunc(filters.limit ?? 200)));
  const filter = draftFilterKey(ownerId, filters);
  const cursor = filters.cursor ? decodeDraftCursor(filters.cursor, filter) : null;
  const backwards = cursor?.direction === "previous";
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

  if (cursor)
    conditions.push(
      backwards
        ? sql`(${drafts.updatedAt}, ${drafts.id}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
        : sql`(${drafts.updatedAt}, ${drafts.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`,
    );

  const rows = await getDb()
    .select({
      cursorTimestamp: sql<string>`to_char(${drafts.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      draft: drafts,
      versionNumber: draftVersions.versionNumber,
      sizeBytes:
        sql<number>`coalesce(${draftVersions.totalSizeBytes}, ${draftVersions.sizeBytes})`.mapWith(
          Number,
        ),
      contentSha256: draftVersions.contentSha256,
      isBundle: draftVersions.isBundle,
    })
    .from(drafts)
    .innerJoin(users, eq(drafts.ownerId, users.id))
    .leftJoin(draftVersions, eq(drafts.currentVersionId, draftVersions.id))
    .where(and(...conditions))
    .orderBy(
      backwards ? asc(drafts.updatedAt) : desc(drafts.updatedAt),
      backwards ? asc(drafts.id) : desc(drafts.id),
    )
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  if (backwards) page.reverse();
  const first = page[0];
  const last = page.at(-1);
  return {
    nextCursor:
      last && (backwards ? Boolean(cursor) : hasMore)
        ? encodeDraftCursor({
            at: last.cursorTimestamp,
            id: last.draft.id,
            filter,
            direction: "next",
          })
        : null,
    previousCursor:
      first && (backwards ? hasMore : Boolean(cursor))
        ? encodeDraftCursor({
            at: first.cursorTimestamp,
            id: first.draft.id,
            filter,
            direction: "previous",
          })
        : null,
    drafts: page.map((row) => ({
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
    })),
  };
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
