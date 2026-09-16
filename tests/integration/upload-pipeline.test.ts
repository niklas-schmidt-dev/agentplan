import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

// Must be configured before the lazy storage/db singletons are first used.
const storageRoot = mkdtempSync(path.join(os.tmpdir(), "agentplan-storage-"));
process.env.STORAGE_DRIVER = "fs";
process.env.STORAGE_FS_ROOT = storageRoot;

import { closeDb, getDb } from "@/db/client";
import { getDraftBySlug, getVersionById, listVersions } from "@/db/queries/drafts";
import { drafts, users } from "@/db/schema";
import { getStorage } from "@/lib/storage";
import {
  addVersionToDraft,
  createDraftWithFirstVersion,
  DraftNotFoundError,
  restoreVersion,
  setDraftVisibility,
  softDeleteDraft,
} from "@/lib/drafts/service";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("upload pipeline (integration)", () => {
  const ownerId = `test-user-${randomUUID()}`;
  const htmlV1 = new TextEncoder().encode("<!doctype html><h1>v1</h1>");
  const htmlV2 = new TextEncoder().encode("<!doctype html><h1>v2</h1>");

  beforeAll(async () => {
    await getDb()
      .insert(users)
      .values({
        id: ownerId,
        name: "Test User",
        email: `${ownerId}@example.test`,
        emailVerified: true,
        role: "admin",
      });
  });

  afterAll(async () => {
    await getDb().delete(users).where(eq(users.id, ownerId));
    await closeDb();
    await rm(storageRoot, { recursive: true, force: true });
  });

  it("publishes, versions, restores bytes, and hides a soft-deleted draft", async () => {
    const result = await createDraftWithFirstVersion({
      ownerId,
      title: "Launch plan",
      visibility: "private",
      bytes: htmlV1,
      source: "browser",
    });
    const draft = result.draft;

    expect(result.version.versionNumber).toBe(1);
    expect(draft.currentVersionId).toBe(result.version.id);
    expect(draft.slug).toMatch(/^draft-[A-Za-z0-9_-]{24}$/);
    expect(draft.slug).not.toContain("launch-plan");
    expect(result.version.contentSha256).toBe(createHash("sha256").update(htmlV1).digest("hex"));
    expect(result.version.storageKey).toBe(
      `drafts/${ownerId}/${draft.id}/${result.version.id}.html`,
    );
    const stored = await readdir(path.join(storageRoot, "drafts", ownerId, draft.id));
    expect(stored).toHaveLength(1);

    const before = await getDraftBySlug(draft.slug);
    const { version: v2, draft: updatedDraft } = await addVersionToDraft({
      draft,
      bytes: htmlV2,
      source: "api_token",
    });
    expect(v2.versionNumber).toBe(2);

    // The returned draft reflects the write, not the caller's stale input copy.
    expect(updatedDraft.currentVersionId).toBe(v2.id);
    expect(updatedDraft.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());
    expect(updatedDraft.updatedAt.getTime()).toBeGreaterThan(draft.updatedAt.getTime());

    const reloaded = await getDraftBySlug(draft.slug);
    expect(reloaded?.currentVersionId).toBe(v2.id);

    const versions = await listVersions(draft.id);
    expect(versions.map((v) => v.versionNumber)).toEqual([2, 1]);
    const v1 = versions.find((v) => v.versionNumber === 1);
    expect(v1?.contentSha256).toBe(createHash("sha256").update(htmlV1).digest("hex"));
    const { version: restored } = await restoreVersion({ draft, version: v1!, source: "browser" });
    expect(restored.versionNumber).toBe(3);
    expect(restored.contentSha256).toBe(v1!.contentSha256);
    expect(restored.id).not.toBe(v1!.id);

    const restoredVersion = await getVersionById(draft.id, restored.id);
    expect(restoredVersion?.storageKey).not.toBe(v1!.storageKey);
    for (const [version, expected] of [
      [v1!, htmlV1],
      [v2, htmlV2],
      [restored, htmlV1],
    ] as const) {
      const object = await getStorage().open(version.storageKey);
      expect(new Uint8Array(await new Response(object!.body).arrayBuffer())).toEqual(expected);
    }

    const beforeVisibility = await readdir(path.join(storageRoot, "drafts", ownerId, draft.id));
    const updated = await setDraftVisibility(draft, "public", { userId: ownerId });
    expect(updated.visibility).toBe("public");
    expect(await getDraftBySlug(updated.slug)).not.toBeNull();
    expect(await readdir(path.join(storageRoot, "drafts", ownerId, draft.id))).toEqual(
      beforeVisibility,
    );

    await softDeleteDraft(updated, { userId: ownerId });
    expect(await getDraftBySlug(updated.slug)).toBeNull();
    expect(await readdir(path.join(storageRoot, "drafts", ownerId, draft.id))).toEqual(
      beforeVisibility,
    );
  });

  it("adding a version to a soft-deleted draft throws DraftNotFoundError", async () => {
    const created = await createDraftWithFirstVersion({
      ownerId,
      title: "Doomed",
      visibility: "private",
      bytes: htmlV1,
      source: "browser",
    });
    await softDeleteDraft(created.draft, { userId: ownerId });

    await expect(
      addVersionToDraft({ draft: created.draft, bytes: htmlV2, source: "browser" }),
    ).rejects.toBeInstanceOf(DraftNotFoundError);

    // The orphaned object from the failed upload was cleaned up.
    const leftover = await readdir(path.join(storageRoot, "drafts", ownerId, created.draft.id));
    // Only the original version 1 object remains; the rejected upload left none.
    expect(leftover).toHaveLength(1);
  });

  it("removes a written object when a subsequent database insert fails", async () => {
    const storage = getStorage();
    const put = vi.spyOn(storage, "put");
    const remove = vi.spyOn(storage, "delete");
    try {
      await expect(
        createDraftWithFirstVersion({
          ownerId,
          title: "Orphan",
          visibility: "private",
          bytes: htmlV1,
          source: "api_token",
          // The version's token foreign key fails after the object and draft are written.
          tokenId: randomUUID(),
        }),
      ).rejects.toMatchObject({ cause: { code: "23503" } });

      expect(put).toHaveBeenCalledTimes(1);
      await expect(put.mock.results[0]!.value).resolves.toBeUndefined();
      const key = put.mock.calls[0]![0];
      expect(remove).toHaveBeenCalledWith(key);
      expect(await storage.head(key)).toBeNull();
      expect(
        await getDb()
          .select()
          .from(drafts)
          .where(and(eq(drafts.ownerId, ownerId), eq(drafts.title, "Orphan"))),
      ).toEqual([]);
    } finally {
      put.mockRestore();
      remove.mockRestore();
    }
  });
});
