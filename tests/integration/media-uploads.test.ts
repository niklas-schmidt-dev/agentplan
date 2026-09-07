import { purgeStorageDeletionJobs } from "@/lib/storage/cleanup";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.STORAGE_DRIVER = "fs";
process.env.STORAGE_FS_ROOT = mkdtempSync(path.join(os.tmpdir(), "agentplan-media-"));
process.env.BETTER_AUTH_SECRET ??= "media-integration-test-secret-not-for-production";

import { GET as getContent, HEAD as headContent } from "@/app/p/[slug]/content/route";
import { closeDb, getDb } from "@/db/client";
import { draftVersions, storageDeletionJobs, uploadIntents, users } from "@/db/schema";
import { getUserStorageUsage } from "@/lib/limits/enforce";
import { getStorage } from "@/lib/storage";
import {
  cancelUploadIntent,
  completeUploadIntent,
  createUploadIntent,
  failUploadIntent,
  UploadIntentConflictError,
} from "@/lib/uploads/service";
import { MediaValidationError } from "@/lib/validation/media";
import { claimCompletion, releaseCompletion } from "@/lib/uploads/completion-lease";
import { eq, sql } from "drizzle-orm";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("media upload lifecycle (integration)", () => {
  const ownerId = `media-owner-${randomUUID()}`;
  let png: Uint8Array;

  beforeAll(async () => {
    await getDb()
      .insert(users)
      .values({
        id: ownerId,
        name: "Media Owner",
        email: `${ownerId}@example.test`,
        emailVerified: true,
        // Keep this seed valid even when test ordering leaves the database
        // empty; the signup-policy trigger rewrites later inserts to user.
        role: "admin",
      });
    png = new Uint8Array(
      await sharp({
        create: { width: 16, height: 16, channels: 3, background: "#82ff77" },
      })
        .png()
        .toBuffer(),
    );
  });

  afterAll(async () => {
    await getDb().delete(users).where(eq(users.id, ownerId));
    await closeDb();
  });

  async function imageIntent(
    target:
      | { type: "new"; title: string; visibility: "private" | "public" }
      | { type: "draft"; draftId: string },
  ) {
    return createUploadIntent({
      ownerId,
      source: "browser",
      filename: "sample.PNG",
      contentType: "image/png",
      sizeBytes: png.byteLength,
      target,
      baseUrl: "http://localhost:3000",
    });
  }

  it("reserves, validates, copies, records, and idempotently completes an image", async () => {
    const created = await imageIntent({
      type: "new",
      title: "Sample image",
      visibility: "private",
    });
    expect((await getUserStorageUsage(ownerId)).reservedBytes).toBe(png.byteLength);
    await getStorage().put(created.intent.stagingKey!, png, "image/png");

    const first = await completeUploadIntent(created.intent.id, ownerId);
    const second = await completeUploadIntent(created.intent.id, ownerId);
    expect(second.version.id).toBe(first.version.id);
    expect(first.draft.kind).toBe("image");
    expect(first.version.originalFilename).toBe("sample.PNG");
    expect(first.version.contentType).toBe("image/png");
    expect(await getStorage().head(first.intent.finalKey)).not.toBeNull();
    expect((await getUserStorageUsage(ownerId)).reservedBytes).toBe(0);

    const versions = await getDb()
      .select()
      .from(draftVersions)
      .where(eq(draftVersions.draftId, first.draft.id));
    expect(versions).toHaveLength(1);
  });

  it("coordinates overlapping completions before storage work", async () => {
    const created = await imageIntent({ type: "new", title: "Concurrent", visibility: "private" });
    await getStorage().put(created.intent.stagingKey!, png, "image/png");
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const original = getStorage().copy.bind(getStorage());
    const copy = vi.spyOn(getStorage(), "copy").mockImplementation(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    const first = completeUploadIntent(created.intent.id, ownerId);
    try {
      await started;
      await expect(completeUploadIntent(created.intent.id, ownerId)).rejects.toBeInstanceOf(
        UploadIntentConflictError,
      );
      expect(copy).toHaveBeenCalledTimes(1);
    } finally {
      resume();
      copy.mockRestore();
    }
    const result = await first;
    expect((await completeUploadIntent(created.intent.id, ownerId)).version.id).toBe(
      result.version.id,
    );
    expect(
      await getDb().select().from(draftVersions).where(eq(draftVersions.draftId, result.draft.id)),
    ).toHaveLength(1);
  });

  it("retains cleanup when an in-flight copy finishes after cancellation", async () => {
    const created = await imageIntent({
      type: "new",
      title: "Cancel during copy",
      visibility: "private",
    });
    await getStorage().put(created.intent.stagingKey!, png, "image/png");
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const copy = vi
      .spyOn(getStorage(), "copy")
      .mockImplementation(async (_source, destination, type) => {
        entered();
        await gate;
        await getStorage().putIfAbsent(destination, png, type);
      });
    const result = completeUploadIntent(created.intent.id, ownerId).catch((error) => error);
    try {
      await started;
      await cancelUploadIntent(ownerId, created.intent.id);
      resume();
      expect(await result).toBeInstanceOf(UploadIntentConflictError);
      expect(await getStorage().head(created.intent.finalKey)).not.toBeNull();
      const [job] = await getDb()
        .select()
        .from(storageDeletionJobs)
        .where(eq(storageDeletionJobs.storageKey, created.intent.finalKey));
      expect(job!.notBefore.getTime()).toBeGreaterThan(created.intent.expiresAt.getTime());
      await getDb()
        .update(storageDeletionJobs)
        .set({ notBefore: sql`now()`, nextAttemptAt: sql`now()` })
        .where(eq(storageDeletionJobs.id, job!.id));
      await purgeStorageDeletionJobs();
      expect(await getStorage().head(created.intent.finalKey)).toBeNull();
      expect(
        await getDb()
          .select()
          .from(draftVersions)
          .where(eq(draftVersions.id, created.intent.versionId)),
      ).toHaveLength(0);
    } finally {
      resume();
      copy.mockRestore();
    }
  });

  it("recovers an expired lease and fences stale failure and release", async () => {
    const created = await imageIntent({
      type: "new",
      title: "Crashed worker",
      visibility: "private",
    });
    const oldToken = (await claimCompletion(created.intent.id))!;
    expect(await claimCompletion(created.intent.id)).toBeNull();
    await getDb()
      .update(uploadIntents)
      .set({ completionExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(uploadIntents.id, created.intent.id));
    const token = (await claimCompletion(created.intent.id))!;
    expect(token).not.toBe(oldToken);
    await failUploadIntent(created.intent, "STALE_WORKER", oldToken);
    await releaseCompletion(created.intent.id, oldToken);
    const [pending] = await getDb()
      .select()
      .from(uploadIntents)
      .where(eq(uploadIntents.id, created.intent.id));
    expect(pending).toMatchObject({ status: "pending", completionToken: token });
    await releaseCompletion(created.intent.id, token);
    await getStorage().put(created.intent.stagingKey!, png, "image/png");
    expect((await completeUploadIntent(created.intent.id, ownerId)).intent.status).toBe(
      "completed",
    );
  });

  it("pins older image bytes and preserves both images when the version cap is reached", async () => {
    vi.stubEnv("AP_MAX_IMAGE_VERSIONS_PER_DRAFT", "2");
    try {
      const firstIntent = await imageIntent({
        type: "new",
        title: "Image history",
        visibility: "public",
      });
      await getStorage().put(firstIntent.intent.stagingKey!, png, "image/png");
      const first = await completeUploadIntent(firstIntent.intent.id, ownerId);
      const updatedPng = new Uint8Array(
        await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ff0000" } })
          .png()
          .toBuffer(),
      );
      const secondIntent = await createUploadIntent({
        ownerId,
        source: "browser",
        filename: "new.png",
        contentType: "image/png",
        sizeBytes: updatedPng.byteLength,
        target: { type: "draft", draftId: first.draft.id },
        baseUrl: "http://localhost:3000",
      });
      await getStorage().put(secondIntent.intent.stagingKey!, updatedPng, "image/png");
      await completeUploadIntent(secondIntent.intent.id, ownerId);
      await expect(imageIntent({ type: "draft", draftId: first.draft.id })).rejects.toThrow(
        /Version limit reached.*preserved/,
      );
      const params = { params: Promise.resolve({ slug: first.draft.slug }) };
      const pinned = await getContent(
        new Request(`http://localhost/p/${first.draft.slug}/content?version=${first.version.id}`),
        params,
      );
      expect(pinned.status).toBe(200);
      expect(pinned.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await pinned.arrayBuffer())).toEqual(png);
      const versions = await getDb()
        .select()
        .from(draftVersions)
        .where(eq(draftVersions.draftId, first.draft.id));
      expect(versions.map((version) => version.id)).toContain(first.version.id);
      expect(versions).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("cancellation releases reservation and leaves durable cleanup metadata", async () => {
    const created = await imageIntent({
      type: "new",
      title: "Cancelled image",
      visibility: "private",
    });
    expect((await getUserStorageUsage(ownerId)).reservedBytes).toBe(png.byteLength);
    await cancelUploadIntent(ownerId, created.intent.id);
    expect((await getUserStorageUsage(ownerId)).reservedBytes).toBe(0);
    const [intent] = await getDb()
      .select({ status: uploadIntents.status })
      .from(uploadIntents)
      .where(eq(uploadIntents.id, created.intent.id));
    expect(intent?.status).toBe("cancelled");
  });

  it("rejects unsupported SVG from the direct-upload path", async () => {
    await expect(
      createUploadIntent({
        ownerId,
        source: "browser",
        filename: "image.svg",
        contentType: "image/svg+xml",
        sizeBytes: 10,
        target: { type: "new", title: "Page", visibility: "private" },
        baseUrl: "http://localhost:3000",
      }),
    ).rejects.toBeInstanceOf(MediaValidationError);
  });

  it("serves video HEAD, ranges, and mismatched If-Range correctly", async () => {
    const mp4 = new Uint8Array([
      0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 105, 115,
      111, 50,
    ]);
    const created = await createUploadIntent({
      ownerId,
      source: "browser",
      filename: "clip.mp4",
      contentType: "video/mp4",
      sizeBytes: mp4.byteLength,
      target: { type: "new", title: "Clip", visibility: "public" },
      baseUrl: "http://localhost:3000",
    });
    await getStorage().put(created.intent.stagingKey!, mp4, "video/mp4");
    const completed = await completeUploadIntent(created.intent.id, ownerId);
    const params = { params: Promise.resolve({ slug: completed.draft.slug }) };
    const url = `http://localhost:3000/p/${completed.draft.slug}/content`;

    const openSpy = vi.spyOn(getStorage(), "open");
    const head = await headContent(new Request(url, { method: "HEAD" }), params);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(mp4.byteLength));
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();

    const partial = await getContent(new Request(url, { headers: { range: "bytes=4-7" } }), params);
    expect(partial.status).toBe(206);
    expect(await partial.text()).toBe("ftyp");
    expect(partial.headers.get("content-range")).toBe(`bytes 4-7/${mp4.byteLength}`);

    const replacement = await getContent(
      new Request(url, {
        headers: { range: "bytes=4-7", "if-range": '"different-version"' },
      }),
      params,
    );
    expect(replacement.status).toBe(200);
    expect((await replacement.arrayBuffer()).byteLength).toBe(mp4.byteLength);

    const unsatisfiable = await getContent(
      new Request(url, { headers: { range: "bytes=99-" } }),
      params,
    );
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe(`bytes */${mp4.byteLength}`);
  });
});
