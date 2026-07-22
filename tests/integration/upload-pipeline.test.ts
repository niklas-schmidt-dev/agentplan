import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Must be configured before the lazy storage/db singletons are first used.
const storageRoot = mkdtempSync(path.join(os.tmpdir(), "agentplan-storage-"));
process.env.STORAGE_DRIVER = "fs";
process.env.STORAGE_FS_ROOT = storageRoot;

import { closeDb, getDb } from "@/db/client";
import { getDraftBySlug, getVersionById, listVersions } from "@/db/queries/drafts";
import { users, type Draft } from "@/db/schema";
import {
  addVersionToDraft,
  createDraftWithFirstVersion,
  restoreVersion,
  setDraftVisibility,
  softDeleteDraft,
} from "@/lib/drafts/service";

const hasDb = Boolean(process.env.DATABASE_URL);

async function filesUnder(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

describe.skipIf(!hasDb)("upload pipeline (integration)", () => {
  const ownerId = `test-user-${randomUUID()}`;
  const htmlV1 = new TextEncoder().encode("<!doctype html><h1>v1</h1>");
  const htmlV2 = new TextEncoder().encode("<!doctype html><h1>v2</h1>");
  let draft: Draft;

  beforeAll(async () => {
    await getDb()
      .insert(users)
      .values({
        id: ownerId,
        name: "Test User",
        email: `${ownerId}@example.test`,
        emailVerified: true,
      });
  });

  afterAll(async () => {
    await closeDb();
  });

  it("creates one draft and one immutable version", async () => {
    const result = await createDraftWithFirstVersion({
      ownerId,
      title: "Launch plan",
      visibility: "private",
      bytes: htmlV1,
      source: "browser",
    });
    draft = result.draft;

    expect(result.version.versionNumber).toBe(1);
    expect(draft.currentVersionId).toBe(result.version.id);
    expect(draft.slug).toMatch(/^launch-plan-[a-z0-9]{4}$/);
    expect(result.version.contentSha256).toBe(
      createHash("sha256").update(htmlV1).digest("hex"),
    );
    expect(result.version.storageKey).toBe(
      `drafts/${ownerId}/${draft.id}/${result.version.id}.html`,
    );
    const stored = await filesUnder(path.join(storageRoot, "drafts", ownerId, draft.id));
    expect(stored).toHaveLength(1);
  });

  it("adds version 2 and moves the current pointer without touching version 1", async () => {
    const v2 = await addVersionToDraft({ draft, bytes: htmlV2, source: "api_token" });
    expect(v2.versionNumber).toBe(2);

    const reloaded = await getDraftBySlug(draft.slug);
    expect(reloaded?.currentVersionId).toBe(v2.id);

    const versions = await listVersions(draft.id);
    expect(versions.map((v) => v.versionNumber)).toEqual([2, 1]);
    const v1 = versions.find((v) => v.versionNumber === 1);
    expect(v1?.contentSha256).toBe(createHash("sha256").update(htmlV1).digest("hex"));
  });

  it("restore produces version N+1 with the restored bytes", async () => {
    const versions = await listVersions(draft.id);
    const v1 = versions.find((v) => v.versionNumber === 1);
    expect(v1).toBeDefined();

    const restored = await restoreVersion({ draft, version: v1!, source: "browser" });
    expect(restored.versionNumber).toBe(3);
    expect(restored.contentSha256).toBe(v1!.contentSha256);
    expect(restored.id).not.toBe(v1!.id);

    const reloaded = await getVersionById(draft.id, restored.id);
    expect(reloaded?.storageKey).not.toBe(v1!.storageKey);
  });

  it("database failure leaves no orphaned object behind", async () => {
    const ghostOwner = `missing-user-${randomUUID()}`;
    await expect(
      createDraftWithFirstVersion({
        ownerId: ghostOwner,
        title: "Orphan",
        visibility: "private",
        bytes: htmlV1,
        source: "browser",
      }),
    ).rejects.toThrow();

    const leftover = await filesUnder(path.join(storageRoot, "drafts", ghostOwner));
    expect(leftover).toHaveLength(0);
  });

  it("visibility change is metadata-only and soft delete hides the draft", async () => {
    const updated = await setDraftVisibility(draft, "public", { userId: ownerId });
    expect(updated.visibility).toBe("public");

    const before = await filesUnder(path.join(storageRoot, "drafts", ownerId, draft.id));

    await softDeleteDraft(draft, { userId: ownerId });
    expect(await getDraftBySlug(draft.slug)).toBeNull();

    // Soft delete keeps stored bytes; only metadata changes.
    const after = await filesUnder(path.join(storageRoot, "drafts", ownerId, draft.id));
    expect(after).toEqual(before);
  });
});
