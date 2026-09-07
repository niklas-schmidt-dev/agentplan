import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Must be configured before the lazy storage/db singletons are first used.
const storageRoot = mkdtempSync(path.join(os.tmpdir(), "agentplan-analytics-"));
process.env.STORAGE_DRIVER = "fs";
process.env.STORAGE_FS_ROOT = storageRoot;
// visitorHash needs a signing secret; any value works for tests.
process.env.BETTER_AUTH_SECRET ??= "analytics-test-secret";

import { eq, inArray, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { draftViewEvents, users } from "@/db/schema";
import {
  getAdminViewStats,
  getDraftViewStats,
  getTopDraftsByViews,
  getViewCountsByOwner,
  getViewCountsForOwner,
} from "@/lib/analytics/queries";
import { purgeExpiredViewEvents, recordDraftView } from "@/lib/analytics/views";
import { addVersionToDraft, createDraftWithFirstVersion } from "@/lib/drafts/service";

const hasDb = Boolean(process.env.DATABASE_URL);
const html = new TextEncoder().encode("<!doctype html><h1>analytics</h1>");

const createdUserIds: string[] = [];

async function createUser(): Promise<string> {
  const id = `analytics-test-${randomUUID()}`;
  await getDb()
    .insert(users)
    .values({
      id,
      name: "Analytics Test User",
      email: `${id}@example.test`,
      emailVerified: true,
      // Satisfies the first-admin trigger on an empty database; when users
      // already exist the trigger downgrades the insert to "user" anyway.
      role: "admin",
    });
  createdUserIds.push(id);
  return id;
}

const anonymousContext = {
  ip: "203.0.113.7",
  userAgent: "integration-test",
  referer: "https://news.ycombinator.com/item?id=1",
  country: "de",
};

describe.skipIf(!hasDb)("view analytics (integration)", () => {
  afterAll(async () => {
    if (createdUserIds.length) {
      await getDb().delete(users).where(inArray(users.id, createdUserIds));
    }
    await closeDb();
  });

  it("records views and aggregates draft stats, excluding owner views", async () => {
    const ownerId = await createUser();
    const { draft } = await createDraftWithFirstVersion({
      ownerId,
      title: "Analytics draft",
      visibility: "public",
      bytes: html,
      source: "browser",
    });

    await recordDraftView({ draftId: draft.id, viewer: "anonymous", context: anonymousContext });
    await recordDraftView({ draftId: draft.id, viewer: "anonymous", context: anonymousContext });
    await recordDraftView({
      draftId: draft.id,
      viewer: "user",
      context: { ip: "198.51.100.9", userAgent: "other", referer: null, country: "US" },
    });
    await recordDraftView({
      draftId: draft.id,
      viewer: "owner",
      context: { ip: "192.0.2.1", userAgent: "owner", referer: null, country: "DE" },
    });

    const stats = await getDraftViewStats(draft.id);
    expect(stats.total).toBe(3);
    expect(stats.last24h).toBe(3);
    expect(stats.last7d).toBe(3);
    expect(stats.last30d).toBe(3);
    // Two distinct visitor hashes: the repeated anonymous visitor and the user.
    expect(stats.visitors30d).toBe(2);
    expect(stats.viewerBreakdown30d).toEqual({ owner: 1, user: 1, anonymous: 2 });
    expect(stats.topReferrers30d).toEqual([{ host: "news.ycombinator.com", views: 2 }]);
    expect(stats.topCountries30d).toEqual([
      { country: "DE", views: 2 },
      { country: "US", views: 1 },
    ]);
    expect(stats.byDay).toHaveLength(30);
    expect(stats.byDay.reduce((sum, day) => sum + day.views, 0)).toBe(3);
    expect(stats.byDay.at(-1)?.views).toBe(3);

    const ownerCounts = await getViewCountsForOwner(ownerId);
    expect(ownerCounts.get(draft.id)).toEqual({ total: 3, last7d: 3 });

    const byOwner = await getViewCountsByOwner([ownerId]);
    expect(byOwner.get(ownerId)).toBe(3);

    const adminStats = await getAdminViewStats();
    expect(adminStats.total).toBeGreaterThanOrEqual(3);

    const top = await getTopDraftsByViews({ days: 7, limit: 20 });
    const entry = top.find((row) => row.draftId === draft.id);
    expect(entry?.views).toBe(3);
    expect(entry?.ownerEmail).toBe(`${ownerId}@example.test`);
  });

  it("scopes every metric to the rendered version while retaining unattributed history in draft totals", async () => {
    const ownerId = await createUser();
    const { draft } = await createDraftWithFirstVersion({
      ownerId,
      title: "Version analytics",
      visibility: "public",
      bytes: html,
      source: "browser",
    });
    const firstId = draft.currentVersionId!;
    const { version: second } = await addVersionToDraft({ draft, bytes: html, source: "browser" });
    await recordDraftView({ draftId: draft.id, viewer: "anonymous", context: anonymousContext });
    await recordDraftView({
      draftId: draft.id,
      versionId: firstId,
      viewer: "anonymous",
      context: anonymousContext,
    });
    await recordDraftView({
      draftId: draft.id,
      versionId: firstId,
      viewer: "owner",
      context: anonymousContext,
    });
    await recordDraftView({
      draftId: draft.id,
      versionId: second.id,
      viewer: "user",
      context: {
        ip: "198.51.100.9",
        userAgent: "other",
        referer: "https://example.com",
        country: "US",
      },
    });

    const stats = await getDraftViewStats(draft.id, firstId);
    expect([stats.total, stats.last24h, stats.last7d, stats.last30d, stats.visitors30d]).toEqual([
      1, 1, 1, 1, 1,
    ]);
    expect(stats.viewerBreakdown30d).toEqual({ owner: 1, user: 0, anonymous: 1 });
    expect(stats.topReferrers30d).toEqual([{ host: "news.ycombinator.com", views: 1 }]);
    expect(stats.topCountries30d).toEqual([{ country: "DE", views: 1 }]);
    expect(stats.byDay.reduce((sum, day) => sum + day.views, 0)).toBe(1);
    expect(stats.byDay.at(-1)?.visitors).toBe(1);
    const latest = await getDraftViewStats(draft.id, second.id);
    expect(latest.total).toBe(1);
    expect(latest.viewerBreakdown30d).toEqual({ owner: 0, user: 1, anonymous: 0 });
    expect(latest.topCountries30d).toEqual([{ country: "US", views: 1 }]);
    expect((await getDraftViewStats(draft.id)).total).toBe(3);
    expect((await getDraftViewStats(randomUUID(), firstId)).total).toBe(0);
  });

  it("purges only events older than the retention window", async () => {
    const ownerId = await createUser();
    const { draft } = await createDraftWithFirstVersion({
      ownerId,
      title: "Retention draft",
      visibility: "public",
      bytes: html,
      source: "browser",
    });

    await getDb()
      .insert(draftViewEvents)
      .values([
        { draftId: draft.id, viewer: "anonymous" },
        {
          draftId: draft.id,
          viewer: "anonymous",
          viewedAt: sql`now() - interval '400 days'`,
        },
      ]);

    const purged = await purgeExpiredViewEvents();
    expect(purged).toBeGreaterThanOrEqual(1);

    const remaining = await getDb()
      .select()
      .from(draftViewEvents)
      .where(eq(draftViewEvents.draftId, draft.id));
    expect(remaining).toHaveLength(1);
  });
});
