import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.STORAGE_DRIVER = "fs";
process.env.STORAGE_FS_ROOT = mkdtempSync(path.join(os.tmpdir(), "agentplan-bundle-"));
process.env.BETTER_AUTH_SECRET ??= "bundle-integration-test-secret-not-for-production";

import { GET as getCurrentContent } from "@/app/p/[slug]/content/route";
import { GET as getVersionedContent } from "@/app/p/[slug]/v/[versionId]/[...logicalPath]/route";
import { closeDb, getDb } from "@/db/client";
import { draftVersions, storageDeletionJobs, uploadIntents, users } from "@/db/schema";
import { removeDraftAsAdmin } from "@/lib/admin/service";
import { createDraftWithFirstVersion } from "@/lib/drafts/service";
import { getStorage } from "@/lib/storage";
import { completeBundleUpload, createBundleUpload, getBundleForOwner } from "@/lib/uploads/bundles";
import { eq } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("bundle upload lifecycle (integration)", () => {
  const ownerId = `bundle-owner-${randomUUID()}`;
  let png: Uint8Array;

  beforeAll(async () => {
    await getDb()
      .insert(users)
      .values({
        id: ownerId,
        name: "Bundle Owner",
        email: `${ownerId}@example.test`,
        emailVerified: true,
      });
    png = new Uint8Array(
      await sharp({
        create: { width: 8, height: 8, channels: 3, background: "#82ff77" },
      })
        .png()
        .toBuffer(),
    );
  });

  afterAll(async () => {
    await getDb().delete(users).where(eq(users.id, ownerId));
    await closeDb();
  });

  async function uploadBundle(target: Parameters<typeof createBundleUpload>[0]["target"]) {
    const html = new TextEncoder().encode('<!doctype html><img src="images/hero.png" alt="hero">');
    const created = await createBundleUpload({
      ownerId,
      source: "browser",
      entryPath: "nested/index.html",
      files: [
        {
          path: "nested/index.html",
          contentType: "text/html",
          sizeBytes: html.byteLength,
        },
        {
          path: "nested/images/hero.png",
          contentType: "image/png",
          sizeBytes: png.byteLength,
        },
      ],
      target,
    });
    const bundle = await getBundleForOwner(ownerId, created.intent.id);
    expect(bundle).not.toBeNull();
    await getStorage().putIfAbsent(created.intent.finalKey, html, "text/html");
    await getStorage().putIfAbsent(bundle!.files[0]!.finalKey, png, "image/png");
    return completeBundleUpload(created.intent.id, ownerId);
  }

  it("serves pinned HTML and assets, redirects /content, and retains two bundle versions", async () => {
    const entryBytes = new TextEncoder().encode(
      '<!doctype html><img src="images/hero.png" alt="hero">',
    ).byteLength;
    vi.stubEnv("AP_MAX_STORAGE_BYTES_PER_USER", String((entryBytes + png.byteLength) * 2));
    const first = await uploadBundle({
      type: "new",
      title: "Bundled plan",
      visibility: "public",
    });
    const contentUrl = `http://localhost:3000/p/${first.draft.slug}/content`;
    const current = await getCurrentContent(new Request(contentUrl), {
      params: Promise.resolve({ slug: first.draft.slug }),
    });
    expect(current.status).toBe(307);
    expect(current.headers.get("location")).toContain(`/v/${first.version.id}/nested/index.html`);

    const entry = await getVersionedContent(
      new Request(`http://localhost:3000${current.headers.get("location")}`),
      {
        params: Promise.resolve({
          slug: first.draft.slug,
          versionId: first.version.id,
          logicalPath: ["nested", "index.html"],
        }),
      },
    );
    expect(entry.status).toBe(200);
    expect(await entry.text()).toContain('src="images/hero.png"');

    const asset = await getVersionedContent(
      new Request(
        `http://localhost:3000/p/${first.draft.slug}/v/${first.version.id}/nested/images/hero.png`,
      ),
      {
        params: Promise.resolve({
          slug: first.draft.slug,
          versionId: first.version.id,
          logicalPath: ["nested", "images", "hero.png"],
        }),
      },
    );
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe("image/png");

    await uploadBundle({ type: "draft", draftId: first.draft.id });
    const third = await uploadBundle({ type: "draft", draftId: first.draft.id });
    const versions = await getDb()
      .select()
      .from(draftVersions)
      .where(eq(draftVersions.draftId, first.draft.id));
    expect(versions.filter((version) => version.isBundle)).toHaveLength(2);
    expect(versions.some((version) => version.id === first.version.id)).toBe(false);
    expect(third.version.versionNumber).toBe(3);
    vi.unstubAllEnvs();
  });

  it("moderation cancels a pending bundle and inventories its immutable keys", async () => {
    const actorId = `bundle-admin-${randomUUID()}`;
    await getDb()
      .insert(users)
      .values({
        id: actorId,
        name: "Bundle Admin",
        email: `${actorId}@example.test`,
        emailVerified: true,
        role: "admin",
      });
    await getDb().update(users).set({ role: "admin" }).where(eq(users.id, actorId));
    try {
      const { draft } = await createDraftWithFirstVersion({
        ownerId,
        title: "Moderated bundle target",
        visibility: "private",
        bytes: new TextEncoder().encode("<!doctype html><p>old</p>"),
        source: "browser",
      });
      const entry = new TextEncoder().encode("<!doctype html><p>pending</p>");
      const pending = await createBundleUpload({
        ownerId,
        source: "browser",
        entryPath: "index.html",
        files: [{ path: "index.html", contentType: "text/html", sizeBytes: entry.byteLength }],
        target: { type: "draft", draftId: draft.id },
      });
      await removeDraftAsAdmin({ userId: actorId }, draft.id);
      const [intent] = await getDb()
        .select({ status: uploadIntents.status })
        .from(uploadIntents)
        .where(eq(uploadIntents.id, pending.intent.id));
      expect(intent?.status).toBe("cancelled");
      const [cleanup] = await getDb()
        .select({ notBefore: storageDeletionJobs.notBefore })
        .from(storageDeletionJobs)
        .where(eq(storageDeletionJobs.storageKey, pending.intent.finalKey));
      expect(cleanup?.notBefore.getTime()).toBe(pending.intent.expiresAt.getTime());
      await getDb()
        .delete(storageDeletionJobs)
        .where(eq(storageDeletionJobs.storageKey, pending.intent.finalKey));
    } finally {
      await getDb().delete(users).where(eq(users.id, actorId));
    }
  });
});
