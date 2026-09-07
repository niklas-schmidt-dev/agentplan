import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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
import {
  completeBundleUpload,
  createBundleUpload,
  getBundleForOwner,
  restoreBundleVersion,
} from "@/lib/uploads/bundles";
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
        // The signup-policy trigger requires an explicit admin proposal when
        // this test is the first writer against a freshly migrated database.
        // It rewrites the role to user when another account already exists.
        role: "admin",
      });
    png = new Uint8Array(
      await sharp({
        create: { width: 8, height: 8, channels: 3, background: "#82ff77" },
      })
        .png()
        .toBuffer(),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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

  it("serves pinned HTML and assets, redirects /content, and preserves bundle versions at storage limits", async () => {
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
    expect(Object.fromEntries(entry.headers)).toMatchObject({
      "content-security-policy":
        "sandbox allow-scripts allow-forms allow-modals allow-popups; frame-ancestors 'self'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "strict-transport-security": "max-age=63072000; includeSubDomains",
      "cache-control": "public, max-age=0, must-revalidate",
    });
    expect(await entry.text()).toContain('src="images/hero.png"');

    const headSpy = vi.spyOn(getStorage(), "head");
    const openSpy = vi.spyOn(getStorage(), "open");
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
    // The filesystem adapter stats once inside open(); the route adds no HEAD.
    expect(headSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledTimes(1);
    headSpy.mockRestore();
    openSpy.mockRestore();
    expect(asset.headers.get("content-security-policy")).toBe("sandbox; frame-ancestors 'self'");
    expect(asset.headers.get("content-type")).toBe("image/png");

    await uploadBundle({ type: "draft", draftId: first.draft.id });
    await expect(uploadBundle({ type: "draft", draftId: first.draft.id })).rejects.toThrow(
      /Storage quota reached.*preserved/,
    );
    const versions = await getDb()
      .select()
      .from(draftVersions)
      .where(eq(draftVersions.draftId, first.draft.id));
    expect(versions.filter((version) => version.isBundle)).toHaveLength(2);
    expect(versions.some((version) => version.id === first.version.id)).toBe(true);
    expect(await getStorage().get(first.version.storageKey)).not.toBeNull();
    vi.unstubAllEnvs();
  });

  it("resumes verified immutable files after a transient storage failure", async () => {
    const html = new TextEncoder().encode("<!doctype html><h1>Resume</h1>");
    const created = await createBundleUpload({
      ownerId,
      source: "browser",
      entryPath: "index.html",
      files: [
        { path: "index.html", contentType: "text/html", sizeBytes: html.length },
        ...["a.png", "b.png", "c.png"].map((path) => ({
          path,
          contentType: "image/png",
          sizeBytes: png.length,
        })),
      ],
      target: { type: "new", title: "Resume validation", visibility: "public" },
    });
    const bundle = (await getBundleForOwner(ownerId, created.intent.id))!;
    await getStorage().putIfAbsent(bundle.intent.finalKey, html, "text/html");
    for (const file of bundle.files)
      await getStorage().putIfAbsent(file.finalKey, png, "image/png");
    const original = getStorage().open.bind(getStorage());
    const missingKey = bundle.files[2]!.finalKey;
    const read = vi.spyOn(getStorage(), "open").mockImplementation(async (key, options) => {
      if (key === missingKey) throw new Error("temporary provider failure");
      return original(key, options);
    });
    try {
      await expect(completeBundleUpload(created.intent.id, ownerId)).rejects.toThrow(
        "temporary provider failure",
      );
    } finally {
      read.mockRestore();
    }
    const pending = (await getBundleForOwner(ownerId, created.intent.id))!;
    expect(pending.intent.status).toBe("pending");
    expect(pending.intent.verifiedSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(pending.files.slice(0, 2).every((file) => file.verifiedSha256)).toBe(true);
    const retryRead = vi.spyOn(getStorage(), "open");
    try {
      const result = await completeBundleUpload(created.intent.id, ownerId);
      expect(result.intent.status).toBe("completed");
      expect(retryRead.mock.calls.map(([key]) => key)).toEqual([missingKey]);
    } finally {
      retryRead.mockRestore();
    }
  });

  it("cancels a mismatched provider response before serving bundle bytes", async () => {
    const completed = await uploadBundle({
      type: "new",
      title: "Bad provider metadata",
      visibility: "public",
    });
    const cancel = vi.fn();
    const read = vi.spyOn(getStorage(), "open").mockResolvedValue({
      size: 999,
      contentType: "text/html",
      etag: null,
      contentRange: null,
      body: new ReadableStream({ cancel }),
    });
    try {
      const response = await getVersionedContent(
        new Request(
          `http://localhost/p/${completed.draft.slug}/v/${completed.version.id}/nested/index.html`,
        ),
        {
          params: Promise.resolve({
            slug: completed.draft.slug,
            versionId: completed.version.id,
            logicalPath: ["nested", "index.html"],
          }),
        },
      );
      expect(response.status).toBe(404);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
    }
  });

  it("keeps three bundles and restores all assets into a fourth version", async () => {
    const first = await uploadBundle({ type: "new", title: "History", visibility: "public" });
    await uploadBundle({ type: "draft", draftId: first.draft.id });
    await uploadBundle({ type: "draft", draftId: first.draft.id });
    const restored = await restoreBundleVersion({
      ownerId,
      draftId: first.draft.id,
      sourceVersionId: first.version.id,
      source: "browser",
    });
    expect(restored.version.versionNumber).toBe(4);
    expect(restored.version.isBundle).toBe(true);
    for (const version of [first.version, restored.version]) {
      const asset = await getVersionedContent(
        new Request(
          `http://localhost/p/${first.draft.slug}/v/${version.id}/nested/images/hero.png`,
        ),
        {
          params: Promise.resolve({
            slug: first.draft.slug,
            versionId: version.id,
            logicalPath: ["nested", "images", "hero.png"],
          }),
        },
      );
      expect(asset.status).toBe(200);
      expect(new Uint8Array(await asset.arrayBuffer())).toEqual(png);
    }
    const versions = await getDb()
      .select()
      .from(draftVersions)
      .where(eq(draftVersions.draftId, first.draft.id));
    expect(versions).toHaveLength(4);
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
