import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Must be configured before the lazy storage/db singletons are first used.
const storageRoot = mkdtempSync(path.join(os.tmpdir(), "agentplan-purge-"));
process.env.STORAGE_DRIVER = "fs";
process.env.STORAGE_FS_ROOT = storageRoot;

import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { apiTokens, auditEvents, drafts, rateLimits, users } from "@/db/schema";
import { purgeExpiredAuditEvents } from "@/lib/audit/events";
import { purgeDeletedDrafts, purgeExpiredRateLimits } from "@/lib/drafts/purge";
import { addVersionToDraft, createDraftWithFirstVersion, softDeleteDraft } from "@/lib/drafts/service";
import { createToken, purgeRetiredTokens } from "@/lib/tokens/service";

const hasDb = Boolean(process.env.DATABASE_URL);
const html = new TextEncoder().encode("<!doctype html><h1>purge</h1>");

async function filesUnder(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

describe.skipIf(!hasDb)("deleted-draft purge (integration)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("hard-deletes drafts past the retention window, keeps recent deletions", async () => {
    const ownerId = `purge-user-${randomUUID()}`;
    await getDb()
      .insert(users)
      .values({
        id: ownerId,
        name: "Purge User",
        email: `${ownerId}@example.test`,
        emailVerified: true,
        role: "admin",
      });

    const old = await createDraftWithFirstVersion({
      ownerId,
      title: "Old deleted",
      visibility: "private",
      bytes: html,
      source: "browser",
    });
    await addVersionToDraft({ draft: old.draft, bytes: html, source: "browser" });
    const recent = await createDraftWithFirstVersion({
      ownerId,
      title: "Recently deleted",
      visibility: "private",
      bytes: html,
      source: "browser",
    });

    await softDeleteDraft(old.draft, { userId: ownerId });
    await softDeleteDraft(recent.draft, { userId: ownerId });
    // Age one deletion past the 7-day default retention window.
    await getDb()
      .update(drafts)
      .set({ deletedAt: sql`now() - interval '10 days'` })
      .where(eq(drafts.id, old.draft.id));

    await purgeDeletedDrafts();

    const [oldRow] = await getDb().select().from(drafts).where(eq(drafts.id, old.draft.id));
    const [recentRow] = await getDb().select().from(drafts).where(eq(drafts.id, recent.draft.id));
    expect(oldRow).toBeUndefined();
    expect(recentRow?.deletedAt).not.toBeNull();

    // The purged draft's objects are gone; the recent one's remain.
    expect(await filesUnder(path.join(storageRoot, "drafts", ownerId, old.draft.id))).toHaveLength(0);
    expect(
      await filesUnder(path.join(storageRoot, "drafts", ownerId, recent.draft.id)),
    ).toHaveLength(1);
  });

  it("sweeps expired rate-limit windows", async () => {
    const key = `purge-test:${randomUUID()}`;
    await getDb().insert(rateLimits).values({
      key,
      windowStart: sql`now() - interval '2 hours'`,
      count: 5,
      expiresAt: sql`now() - interval '1 hour'`,
    });

    await purgeExpiredRateLimits();

    const rows = await getDb()
      .select()
      .from(rateLimits)
      .where(and(eq(rateLimits.key, key), lte(rateLimits.expiresAt, sql`now()`)));
    expect(rows).toHaveLength(0);
  });

  it("removes retired tokens after retention while preserving active tokens", async () => {
    process.env.AP_RETIRED_TOKEN_RETENTION_DAYS = "30";
    const ownerId = `purge-token-user-${randomUUID()}`;
    await getDb().insert(users).values({
      id: ownerId,
      name: "Token Purge User",
      email: `${ownerId}@example.test`,
      emailVerified: true,
      role: "admin",
    });
    try {
      const revoked = await createToken({
        userId: ownerId,
        name: "old-revoked",
        scopes: ["drafts:read"],
      });
      const expired = await createToken({
        userId: ownerId,
        name: "old-expired",
        scopes: ["drafts:read"],
        expiresAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000),
      });
      const active = await createToken({
        userId: ownerId,
        name: "active",
        scopes: ["drafts:read"],
      });
      await getDb()
        .update(apiTokens)
        .set({ revokedAt: sql`now() - interval '40 days'` })
        .where(eq(apiTokens.id, revoked.record.id));

      expect(await purgeRetiredTokens()).toBe(2);
      const remaining = await getDb()
        .select({ id: apiTokens.id })
        .from(apiTokens)
        .where(
          inArray(apiTokens.id, [
            revoked.record.id,
            expired.record.id,
            active.record.id,
          ]),
        );
      expect(remaining.map(({ id }) => id)).toEqual([active.record.id]);
    } finally {
      delete process.env.AP_RETIRED_TOKEN_RETENTION_DAYS;
    }
  });

  it("applies finite audit retention without deleting pending cleanup jobs", async () => {
    process.env.AP_AUDIT_RETENTION_DAYS = "180";
    try {
      const inserted = await getDb()
        .insert(auditEvents)
        .values([
          {
            eventType: "draft.created",
            metadata: { marker: "stale" },
            createdAt: sql`now() - interval '200 days'`,
          },
          {
            eventType: "draft.created",
            metadata: { marker: "recent" },
          },
          {
            eventType: "user.deletion_pending",
            metadata: {
              targetUserId: "retention-test",
              storageKeys: [],
              storageCleanup: "pending",
            },
            createdAt: sql`now() - interval '200 days'`,
          },
        ])
        .returning({ id: auditEvents.id, eventType: auditEvents.eventType });

      expect(await purgeExpiredAuditEvents()).toBeGreaterThanOrEqual(1);
      const remaining = await getDb()
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(inArray(auditEvents.id, inserted.map(({ id }) => id)));
      expect(remaining.map(({ id }) => id).sort()).toEqual(
        [inserted[1]!.id, inserted[2]!.id].sort(),
      );
      expect(remaining).toHaveLength(2);
    } finally {
      delete process.env.AP_AUDIT_RETENTION_DAYS;
    }
  });
});
