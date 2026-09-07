import { createHash } from "node:crypto";
import { fileTypeFromBuffer, fileTypeFromFile } from "file-type";
import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp, { type Metadata } from "sharp";
import { uploadSpecFor, type UploadSpec } from "@agentplan/upload-contract";
import type { StorageOpenResult } from "@/lib/storage";

export class MediaValidationError extends Error {
  constructor(
    public readonly code: "INVALID_FILE_TYPE" | "EMPTY_FILE" | "SIZE_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "MediaValidationError";
  }
}

export function validateDirectUploadMetadata(input: {
  filename: string;
  contentType: string | null;
  sizeBytes: number;
}): UploadSpec {
  const spec = uploadSpecFor(input.filename, input.contentType);
  if (!spec) {
    throw new MediaValidationError(
      "INVALID_FILE_TYPE",
      "Direct uploads support HTML, JPEG, PNG, WebP, GIF, AVIF, and MP4 files.",
    );
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new MediaValidationError("EMPTY_FILE", "The file is empty.");
  }
  return spec;
}

export async function consumeStoredObject(
  object: StorageOpenResult,
  expectedBytes: number,
  writeChunk?: (chunk: Uint8Array) => Promise<void>,
): Promise<{ prefix: Uint8Array; sha256: string; size: number }> {
  const reader = object.body.getReader();
  const prefixChunks: Uint8Array[] = [];
  const hash = createHash("sha256");
  let size = 0;
  let prefixSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > expectedBytes) {
        await reader.cancel();
        throw new MediaValidationError("SIZE_MISMATCH", "Stored file size does not match.");
      }
      hash.update(value);
      if (writeChunk) await writeChunk(value);
      if (prefixSize < 64 * 1024) {
        const slice = value.slice(0, Math.min(value.byteLength, 64 * 1024 - prefixSize));
        prefixChunks.push(slice);
        prefixSize += slice.byteLength;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (size !== expectedBytes) {
    throw new MediaValidationError("SIZE_MISMATCH", "Stored file size does not match.");
  }
  const join = (parts: Uint8Array[], length: number) => {
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.byteLength;
    }
    return result;
  };
  return {
    prefix: join(prefixChunks, prefixSize),
    sha256: hash.digest("hex"),
    size,
  };
}

export async function validateStoredMedia(input: {
  object: StorageOpenResult;
  expectedBytes: number;
  spec: UploadSpec;
}): Promise<{ contentSha256: string; sizeBytes: number }> {
  // A file-backed input lets Sharp inspect metadata without retaining the entire
  // compressed image twice in JavaScript. The private temporary file is removed
  // on success and every error; HTML/video remain entirely streaming.
  let temporaryDirectory: string | undefined;
  try {
    let imagePath: string | undefined;
    let consumed: Awaited<ReturnType<typeof consumeStoredObject>>;
    if (input.spec.kind === "image") {
      temporaryDirectory = await mkdtemp(
        /* turbopackIgnore: true */ path.join(os.tmpdir(), "agentplan-validation-"),
      );
      imagePath = path.join(temporaryDirectory, "image");
      const file = await open(/* turbopackIgnore: true */ imagePath, "wx", 0o600);
      try {
        consumed = await consumeStoredObject(input.object, input.expectedBytes, async (chunk) => {
          let offset = 0;
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
            if (bytesWritten === 0) throw new Error("Image validation file write stalled");
            offset += bytesWritten;
          }
        });
      } finally {
        await file.close();
      }
    } else {
      consumed = await consumeStoredObject(input.object, input.expectedBytes);
    }
    // HTML is served in the same isolated viewer as legacy multipart uploads.
    // Hash and verify its declared size without buffering the document.
    if (input.spec.kind === "html") {
      return { contentSha256: consumed.sha256, sizeBytes: consumed.size };
    }
    const detected = imagePath
      ? await fileTypeFromFile(/* turbopackIgnore: true */ imagePath)
      : await fileTypeFromBuffer(consumed.prefix);
    if (!detected || detected.mime !== input.spec.contentType) {
      throw new MediaValidationError(
        "INVALID_FILE_TYPE",
        `Stored content is not valid ${input.spec.contentType}.`,
      );
    }

    if (input.spec.kind === "image") {
      if (!imagePath) throw new MediaValidationError("INVALID_FILE_TYPE", "Image data is missing.");
      let metadata: Metadata;
      try {
        metadata = await sharp(/* turbopackIgnore: true */ imagePath, {
          limitInputPixels: 100_000_000,
        }).metadata();
      } catch {
        throw new MediaValidationError("INVALID_FILE_TYPE", "The image is invalid or too large.");
      }
      const width = metadata.width ?? 0;
      const height = metadata.height ?? 0;
      const pages = metadata.pages ?? 1;
      const frameHeight = metadata.pageHeight ?? Math.floor(height / pages);
      const pixelsPerFrame = width * frameHeight;
      if (width <= 0 || height <= 0 || frameHeight <= 0 || pixelsPerFrame > 40_000_000) {
        throw new MediaValidationError("INVALID_FILE_TYPE", "The image dimensions are invalid.");
      }
      if (pixelsPerFrame * pages > 100_000_000) {
        throw new MediaValidationError(
          "INVALID_FILE_TYPE",
          "The animated image contains too many pixels.",
        );
      }
    }

    return { contentSha256: consumed.sha256, sizeBytes: consumed.size };
  } catch (error) {
    // Includes setup failures before the stream has acquired a reader.
    if (!input.object.body.locked) await input.object.body.cancel().catch(() => undefined);
    throw error;
  } finally {
    if (temporaryDirectory)
      await rm(/* turbopackIgnore: true */ temporaryDirectory, { recursive: true, force: true });
  }
}
