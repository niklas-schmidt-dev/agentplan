import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "@/db/client";
import { drafts, draftVersions, storageDeletionJobs, uploadIntents, users } from "@/db/schema";
import { getDraftBySlug, getDraftForOwner, listDraftsForOwner } from "@/db/queries/drafts";
import { purgeDeletedDrafts } from "@/lib/drafts/purge";
import {
  addVersionToDraft,
  createDraftWithFirstVersion,
  DraftNotFoundError,
  restoreVersion,
  setDraftTitle,
} from "@/lib/drafts/service";
import { getUserStorageUsage } from "@/lib/limits/enforce";
import { getStorage } from "@/lib/storage";
import { completeUploadIntent, createUploadIntent } from "@/lib/uploads/service";

mkdirSync(".data", { recursive: true });
const root = mkdtempSync(path.resolve(".data/expiry-test-"));
process.env.STORAGE_DRIVER = "fs";
process.env.STORAGE_FS_ROOT = root;

describe.skipIf(!process.env.DATABASE_URL)("draft auto-expiry", () => {
  const ownerId = `expiry-${randomUUID()}`;
  const bytes = new TextEncoder().encode("<h1>Temporary plan</h1>");
  beforeAll(async () => {
    await getDb()
      .insert(users)
      .values({
        id: ownerId,
        name: "Expiry test",
        email: `${ownerId}@example.test`,
        emailVerified: true,
        role: "admin",
      });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await getDb().delete(users).where(eq(users.id, ownerId));
    await closeDb();
    rmSync(root, { recursive: true, force: true });
  });

  function publish(expiresInSeconds?: number) {
    return createDraftWithFirstVersion({
      ownerId,
      title: "Expiry",
      visibility: "public",
      bytes,
      source: "browser",
      expiresInSeconds,
    });
  }
  async function expire(id: string) {
    await getDb()
      .update(drafts)
      .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(drafts.id, id));
  }

  it("starts the lifetime at publication and preserves it across versions and restores", async () => {
    const intent = await createUploadIntent({
      ownerId,
      source: "browser",
      filename: "plan.html",
      contentType: "text/html",
      sizeBytes: bytes.length,
      target: { type: "new", visibility: "public", expiresInSeconds: 3600 },
      baseUrl: "http://localhost:3000",
    });
    await getDb()
      .update(uploadIntents)
      .set({ createdAt: sql`now() - interval '20 minutes'` })
      .where(eq(uploadIntents.id, intent.intent.id));
    await getStorage().put(intent.intent.stagingKey!, bytes, "text/html");
    const before = Date.now();
    const first = await completeUploadIntent(intent.intent.id, ownerId);
    expect(first.draft.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 3600000);
    expect(first.draft.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 3600000);
    const second = await addVersionToDraft({ draft: first.draft, bytes, source: "browser" });
    const restored = await restoreVersion({
      draft: second.draft,
      version: first.version,
      source: "browser",
    });
    expect(restored.draft.expiresAt).toEqual(first.draft.expiresAt);
    expect((await completeUploadIntent(intent.intent.id, ownerId)).draft.expiresAt).toEqual(
      first.draft.expiresAt,
    );
    expect((await publish()).draft.expiresAt).toBeNull();
  });

  it("revokes reads, quota usage and writes before cleanup, including stale requests", async () => {
    const { draft, version } = await publish(3600);
    const usage = await getUserStorageUsage(ownerId);
    await expire(draft.id);
    expect(await getDraftBySlug(draft.slug)).toBeNull();
    expect(await getDraftForOwner(draft.id, ownerId)).toBeNull();
    expect((await listDraftsForOwner(ownerId)).some((item) => item.id === draft.id)).toBe(false);
    expect((await getUserStorageUsage(ownerId)).committedBytes).toBe(
      usage.committedBytes - bytes.length,
    );
    await expect(addVersionToDraft({ draft, bytes, source: "browser" })).rejects.toBeInstanceOf(
      DraftNotFoundError,
    );
    await expect(restoreVersion({ draft, version, source: "browser" })).rejects.toBeInstanceOf(
      DraftNotFoundError,
    );
    await expect(setDraftTitle(draft, "Revive", { userId: ownerId })).rejects.toBeInstanceOf(
      DraftNotFoundError,
    );
    await expect(
      createUploadIntent({
        ownerId,
        source: "browser",
        filename: "plan.html",
        contentType: "text/html",
        sizeBytes: bytes.length,
        target: { type: "draft", draftId: draft.id },
        baseUrl: "http://localhost:3000",
      }),
    ).rejects.toBeInstanceOf(DraftNotFoundError);
  });

  it("purges all versions, cancels pending uploads durably, and leaves permanent drafts", async () => {
    const permanent = await publish();
    const first = await publish(3600);
    const second = await addVersionToDraft({ draft: first.draft, bytes, source: "browser" });
    const pending = await createUploadIntent({
      ownerId,
      source: "browser",
      filename: "plan.html",
      contentType: "text/html",
      sizeBytes: bytes.length,
      target: { type: "draft", draftId: first.draft.id },
      baseUrl: "http://localhost:3000",
    });
    await expire(first.draft.id);
    await purgeDeletedDrafts();
    expect(await getDb().select().from(drafts).where(eq(drafts.id, first.draft.id))).toHaveLength(
      0,
    );
    expect(
      await getDb().select().from(draftVersions).where(eq(draftVersions.draftId, first.draft.id)),
    ).toHaveLength(0);
    expect(await getStorage().head(first.version.storageKey)).toBeNull();
    expect(await getStorage().head(second.version.storageKey)).toBeNull();
    expect(await getDraftForOwner(permanent.draft.id, ownerId)).not.toBeNull();
    const [cancelled] = await getDb()
      .select()
      .from(uploadIntents)
      .where(eq(uploadIntents.id, pending.intent.id));
    expect(cancelled!.status).toBe("cancelled");
    const jobs = await getDb()
      .select()
      .from(storageDeletionJobs)
      .where(
        inArray(storageDeletionJobs.storageKey, [
          pending.intent.stagingKey!,
          pending.intent.finalKey,
        ]),
      );
    expect(jobs).toHaveLength(2);
    expect(
      jobs.find((job) => job.storageKey === pending.intent.stagingKey)!.notBefore.getTime(),
    ).toBeGreaterThanOrEqual(pending.intent.expiresAt.getTime());
    await expect(completeUploadIntent(pending.intent.id, ownerId)).rejects.toThrow();
  });

  it("keeps an expired tombstone when storage fails and retries on the next run", async () => {
    const { draft, version } = await publish(60);
    await expire(draft.id);
    const originalDelete = getStorage().delete.bind(getStorage());
    const removal = vi.spyOn(getStorage(), "delete").mockImplementation(async (key) => {
      if (key === version.storageKey) throw new Error("Synthetic storage outage");
      return originalDelete(key);
    });
    expect((await purgeDeletedDrafts()).failed).toBe(1);
    expect(
      await getDb()
        .select()
        .from(drafts)
        .where(and(eq(drafts.id, draft.id), sql`${drafts.deletedAt} is not null`)),
    ).toHaveLength(1);
    expect(await getDraftBySlug(draft.slug)).toBeNull();
    removal.mockRestore();
    expect((await purgeDeletedDrafts()).purged).toBeGreaterThanOrEqual(1);
    expect(await getStorage().head(version.storageKey)).toBeNull();
  });
});
