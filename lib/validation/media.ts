import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import sharp, { type Metadata } from "sharp";
import { uploadSpecFor, type UploadSpec } from "@agentplan/upload-contract";
import type { StorageOpenResult } from "@/lib/storage";

export class MediaValidationError extends Error {
  constructor(
    public readonly code: "INVALID_FILE_TYPE" | "FILE_TOO_LARGE" | "EMPTY_FILE" | "SIZE_MISMATCH",
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
  if (!spec || spec.kind === "html") {
    throw new MediaValidationError(
      "INVALID_FILE_TYPE",
      "Direct uploads support JPEG, PNG, WebP, GIF, AVIF, and MP4 files.",
    );
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new MediaValidationError("EMPTY_FILE", "The file is empty.");
  }
  if (input.sizeBytes > spec.maxBytes) {
    throw new MediaValidationError(
      "FILE_TOO_LARGE",
      `The file exceeds the ${spec.maxBytes / (1024 * 1024)} MiB limit.`,
    );
  }
  return spec;
}

async function consumeStream(
  object: StorageOpenResult,
  expectedBytes: number,
  keepBytes: boolean,
): Promise<{ bytes: Uint8Array | null; prefix: Uint8Array; sha256: string; size: number }> {
  const reader = object.body.getReader();
  const chunks: Uint8Array[] = [];
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
      if (keepBytes) chunks.push(value);
      if (prefixSize < 64 * 1024) {
        const slice = value.subarray(0, Math.min(value.byteLength, 64 * 1024 - prefixSize));
        prefixChunks.push(slice);
        prefixSize += slice.byteLength;
      }
    }
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
    bytes: keepBytes ? join(chunks, size) : null,
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
  const consumed = await consumeStream(
    input.object,
    input.expectedBytes,
    input.spec.kind === "image",
  );
  const detected = await fileTypeFromBuffer(consumed.bytes ?? consumed.prefix);
  if (!detected || detected.mime !== input.spec.contentType) {
    throw new MediaValidationError(
      "INVALID_FILE_TYPE",
      `Stored content is not valid ${input.spec.contentType}.`,
    );
  }

  if (input.spec.kind === "image") {
    const bytes = consumed.bytes;
    if (!bytes) throw new MediaValidationError("INVALID_FILE_TYPE", "Image data is missing.");
    let metadata: Metadata;
    try {
      metadata = await sharp(bytes, { limitInputPixels: 100_000_000 }).metadata();
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
}
