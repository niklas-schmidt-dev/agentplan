import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadSpecFor } from "@agentplan/upload-contract";
import type { StorageOpenResult } from "@/lib/storage";
import { validateDirectUploadMetadata, validateStoredMedia } from "@/lib/validation/media";

function objectFor(bytes: Uint8Array, contentType: string): StorageOpenResult {
  return {
    size: bytes.byteLength,
    contentType,
    etag: null,
    contentRange: null,
    body: Readable.toWeb(Readable.from([bytes])) as ReadableStream<Uint8Array>,
  };
}

describe("media validation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts every registered kind including HTML direct uploads", () => {
    expect(
      validateDirectUploadMetadata({
        filename: "photo.JpEg",
        contentType: "image/jpeg",
        sizeBytes: 100,
      }).kind,
    ).toBe("image");
    expect(
      validateDirectUploadMetadata({
        filename: "page.html",
        contentType: "text/html",
        sizeBytes: 3 * 1024 * 1024,
      }).kind,
    ).toBe("html");
    expect(
      validateDirectUploadMetadata({
        filename: "movie.mp4",
        contentType: "video/mp4",
        sizeBytes: 100,
      }).kind,
    ).toBe("video");
  });

  it.each([
    ["photo.png", "image/png", 11 * 1024 ** 2],
    ["movie.mp4", "video/mp4", 3 * 1024 ** 3],
  ])("accepts %s above the former byte limit", (filename, contentType, sizeBytes) => {
    expect(validateDirectUploadMetadata({ filename, contentType, sizeBytes })).toBeDefined();
  });

  it("streams large HTML and rejects bytes beyond the reservation", async () => {
    const bytes = new TextEncoder().encode("<!doctype html>" + "x".repeat(3 * 1024 ** 2));
    const spec = uploadSpecFor("plan.html", "text/html")!;
    const result = await validateStoredMedia({
      object: objectFor(bytes, "text/html"),
      expectedBytes: bytes.byteLength,
      spec,
    });
    expect(result.sizeBytes).toBe(bytes.byteLength);
    expect(result.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      validateStoredMedia({
        object: objectFor(bytes, "text/html"),
        expectedBytes: bytes.byteLength - 1,
        spec,
      }),
    ).rejects.toMatchObject({ code: "SIZE_MISMATCH" });
  });

  it("ignores stale upload-kind configuration", () => {
    vi.stubEnv("AP_ENABLED_UPLOAD_KINDS", "html");

    expect(
      validateDirectUploadMetadata({
        filename: "photo.webp",
        contentType: "image/webp",
        sizeBytes: 100,
      }).kind,
    ).toBe("image");
    expect(
      validateDirectUploadMetadata({
        filename: "movie.mp4",
        contentType: "video/mp4",
        sizeBytes: 100,
      }).kind,
    ).toBe("video");
  });

  it("validates image magic, dimensions, byte count, and hash", async () => {
    const bytes = new Uint8Array(
      await sharp({
        create: { width: 8, height: 8, channels: 3, background: "#82ff77" },
      })
        .png()
        .toBuffer(),
    );
    const spec = uploadSpecFor("pixel.png", "image/png");
    expect(spec).not.toBeNull();
    const result = await validateStoredMedia({
      object: objectFor(bytes, "image/png"),
      expectedBytes: bytes.byteLength,
      spec: spec!,
    });
    expect(result.sizeBytes).toBe(bytes.byteLength);
    expect(result.contentSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects extension/MIME content whose magic bytes disagree", async () => {
    const bytes = new TextEncoder().encode("not a png");
    const spec = uploadSpecFor("fake.png", "image/png")!;
    await expect(
      validateStoredMedia({
        object: objectFor(bytes, "image/png"),
        expectedBytes: bytes.byteLength,
        spec,
      }),
    ).rejects.toMatchObject({ code: "INVALID_FILE_TYPE" });
  });

  it("removes private temporary image files after success, bad magic, and interrupted input", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentplan-image-test-"));
    const tmpdir = vi.spyOn(os, "tmpdir").mockReturnValue(root);
    try {
      const bytes = new Uint8Array(
        await sharp({ create: { width: 8, height: 8, channels: 3, background: "#82ff77" } })
          .png()
          .toBuffer(),
      );
      const spec = uploadSpecFor("pixel.png", "image/png")!;
      await validateStoredMedia({
        object: objectFor(bytes, "image/png"),
        expectedBytes: bytes.length,
        spec,
      });
      expect(await readdir(root)).toEqual([]);
      await expect(
        validateStoredMedia({
          object: objectFor(new Uint8Array(10), "image/png"),
          expectedBytes: 10,
          spec,
        }),
      ).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
      const object = objectFor(bytes, "image/png");
      object.body = new ReadableStream({
        pull(controller) {
          controller.error(new Error("connection lost"));
        },
      });
      await expect(
        validateStoredMedia({ object, expectedBytes: bytes.length, spec }),
      ).rejects.toThrow("connection lost");
      expect(await readdir(root)).toEqual([]);
    } finally {
      tmpdir.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hashes a streamed MP4 without buffering the complete video", async () => {
    const bytes = new Uint8Array([
      0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 105, 115,
      111, 50,
    ]);
    const spec = uploadSpecFor("clip.mp4", "video/mp4")!;
    await expect(
      validateStoredMedia({
        object: objectFor(bytes, "video/mp4"),
        expectedBytes: bytes.byteLength,
        spec,
      }),
    ).resolves.toMatchObject({ sizeBytes: bytes.byteLength });
  });
});
