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
import { draftVersions, uploadIntents, users } from "@/db/schema";
import { getUserStorageUsage } from "@/lib/limits/enforce";
import { getStorage } from "@/lib/storage";
import {
  cancelUploadIntent,
  completeUploadIntent,
  createUploadIntent,
} from "@/lib/uploads/service";
import { MediaValidationError } from "@/lib/validation/media";
import { eq } from "drizzle-orm";

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
      { type: "new"; title: string; visibility: "private" } | { type: "draft"; draftId: string },
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

  it("rejects HTML from the direct-upload path", async () => {
    await expect(
      createUploadIntent({
        ownerId,
        source: "browser",
        filename: "page.Html",
        contentType: "text/html",
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
