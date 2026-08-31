import { and, count, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { draftViewEvents, drafts, users, type DraftViewerKind } from "@/db/schema";

/**
 * Owner views are recorded (for the honest breakdown) but excluded from every
 * headline count: refreshing your own draft should not look like traffic.
 */
const visitorFilter = ne(draftViewEvents.viewer, "owner");

function since(days: number) {
  return gte(draftViewEvents.viewedAt, sql`now() - make_interval(days => ${days})`);
}

export type DailyViews = { day: string; views: number; visitors: number };

export type DraftViewStats = {
  total: number;
  last24h: number;
  last7d: number;
  last30d: number;
  /** Distinct daily visitors over the last 30 days (excluding the owner). */
  visitors30d: number;
  /** Last 30 UTC days, oldest first, zero-filled. */
  byDay: DailyViews[];
  viewerBreakdown30d: Record<DraftViewerKind, number>;
  topReferrers30d: Array<{ host: string; views: number }>;
  topCountries30d: Array<{ country: string; views: number }>;
};

/** Returns the last `days` UTC dates (YYYY-MM-DD), oldest first. */
function utcDayWindow(days: number, now: Date = new Date()): string[] {
  const result: string[] = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    result.push(new Date(now.getTime() - offset * 24 * 3600 * 1000).toISOString().slice(0, 10));
  }
  return result;
}

export async function getDraftViewStats(draftId: string): Promise<DraftViewStats> {
  const db = getDb();
  const forDraft = eq(draftViewEvents.draftId, draftId);
  const utcDay = sql<string>`to_char(${draftViewEvents.viewedAt} at time zone 'utc', 'YYYY-MM-DD')`;

  const [[totals], dayRows, breakdownRows, referrerRows, countryRows] = await Promise.all([
    db
      .select({
        total: count(),
        last24h: sql<number>`count(*) filter (where ${draftViewEvents.viewedAt} > now() - interval '24 hours')::int`,
        last7d: sql<number>`count(*) filter (where ${draftViewEvents.viewedAt} > now() - interval '7 days')::int`,
        last30d: sql<number>`count(*) filter (where ${draftViewEvents.viewedAt} > now() - interval '30 days')::int`,
        visitors30d: sql<number>`count(distinct ${draftViewEvents.visitorHash}) filter (where ${draftViewEvents.viewedAt} > now() - interval '30 days')::int`,
      })
      .from(draftViewEvents)
      .where(and(forDraft, visitorFilter)),
    db
      .select({
        day: utcDay,
        views: count(),
        visitors: sql<number>`count(distinct ${draftViewEvents.visitorHash})::int`,
      })
      .from(draftViewEvents)
      .where(and(forDraft, visitorFilter, since(30)))
      .groupBy(utcDay),
    db
      .select({ viewer: draftViewEvents.viewer, views: count() })
      .from(draftViewEvents)
      .where(and(forDraft, since(30)))
      .groupBy(draftViewEvents.viewer),
    db
      .select({ host: draftViewEvents.referrerHost, views: count() })
      .from(draftViewEvents)
      .where(and(forDraft, visitorFilter, since(30), isNotNull(draftViewEvents.referrerHost)))
      .groupBy(draftViewEvents.referrerHost)
      .orderBy(desc(count()))
      .limit(5),
    db
      .select({ country: draftViewEvents.country, views: count() })
      .from(draftViewEvents)
      .where(and(forDraft, visitorFilter, since(30), isNotNull(draftViewEvents.country)))
      .groupBy(draftViewEvents.country)
      .orderBy(desc(count()))
      .limit(5),
  ]);

  const byDayMap = new Map(dayRows.map((row) => [row.day, row]));
  const breakdown: Record<DraftViewerKind, number> = { owner: 0, user: 0, anonymous: 0 };
  for (const row of breakdownRows) breakdown[row.viewer] = row.views;

  return {
    total: totals?.total ?? 0,
    last24h: totals?.last24h ?? 0,
    last7d: totals?.last7d ?? 0,
    last30d: totals?.last30d ?? 0,
    visitors30d: totals?.visitors30d ?? 0,
    byDay: utcDayWindow(30).map((day) => ({
      day,
      views: byDayMap.get(day)?.views ?? 0,
      visitors: byDayMap.get(day)?.visitors ?? 0,
    })),
    viewerBreakdown30d: breakdown,
    topReferrers30d: referrerRows.map((row) => ({ host: row.host!, views: row.views })),
    topCountries30d: countryRows.map((row) => ({ country: row.country!, views: row.views })),
  };
}

export type DraftViewCounts = { total: number; last7d: number };

/** Per-draft view counts (excluding owner views) for one owner's live drafts. */
export async function getViewCountsForOwner(
  ownerId: string,
): Promise<Map<string, DraftViewCounts>> {
  const rows = await getDb()
    .select({
      draftId: draftViewEvents.draftId,
      total: count(),
      last7d: sql<number>`count(*) filter (where ${draftViewEvents.viewedAt} > now() - interval '7 days')::int`,
    })
    .from(draftViewEvents)
    .innerJoin(drafts, eq(draftViewEvents.draftId, drafts.id))
    .where(and(eq(drafts.ownerId, ownerId), isNull(drafts.deletedAt), visitorFilter))
    .groupBy(draftViewEvents.draftId);
  return new Map(rows.map((row) => [row.draftId, { total: row.total, last7d: row.last7d }]));
}

/** Views (excluding owners) on each page user's live drafts over the last 30 days. */
export async function getViewCountsByOwner(ownerIds: string[]): Promise<Map<string, number>> {
  if (ownerIds.length === 0) return new Map();
  const rows = await getDb()
    .select({ ownerId: drafts.ownerId, views: count() })
    .from(draftViewEvents)
    .innerJoin(drafts, eq(draftViewEvents.draftId, drafts.id))
    .where(
      and(inArray(drafts.ownerId, ownerIds), isNull(drafts.deletedAt), visitorFilter, since(30)),
    )
    .groupBy(drafts.ownerId);
  return new Map(rows.map((row) => [row.ownerId, row.views]));
}

export type AdminViewStats = {
  total: number;
  last24h: number;
  last7d: number;
};

export async function getAdminViewStats(): Promise<AdminViewStats> {
  const [row] = await getDb()
    .select({
      total: count(),
      last24h: sql<number>`count(*) filter (where ${draftViewEvents.viewedAt} > now() - interval '24 hours')::int`,
      last7d: sql<number>`count(*) filter (where ${draftViewEvents.viewedAt} > now() - interval '7 days')::int`,
    })
    .from(draftViewEvents)
    .where(visitorFilter);
  return { total: row?.total ?? 0, last24h: row?.last24h ?? 0, last7d: row?.last7d ?? 0 };
}

export type TopDraftRow = {
  draftId: string;
  slug: string;
  title: string;
  visibility: string;
  ownerEmail: string;
  views: number;
};

/** Most-viewed live drafts (excluding owner views) over the last `days` days. */
export async function getTopDraftsByViews({
  days = 7,
  limit = 5,
}: {
  days?: number;
  limit?: number;
} = {}): Promise<TopDraftRow[]> {
  const rows = await getDb()
    .select({
      draftId: drafts.id,
      slug: drafts.slug,
      title: drafts.title,
      visibility: drafts.visibility,
      ownerEmail: users.email,
      views: count(),
    })
    .from(draftViewEvents)
    .innerJoin(drafts, eq(draftViewEvents.draftId, drafts.id))
    .innerJoin(users, eq(drafts.ownerId, users.id))
    .where(and(isNull(drafts.deletedAt), visitorFilter, since(days)))
    .groupBy(drafts.id, drafts.slug, drafts.title, drafts.visibility, users.email)
    .orderBy(desc(count()), desc(drafts.updatedAt))
    .limit(Math.min(Math.max(Math.trunc(limit), 1), 20));
  return rows;
}
