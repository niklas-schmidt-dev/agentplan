import {
  BlobNotFoundError,
  copy as copyBlob,
  del as deleteBlob,
  get as getBlob,
  head as headBlob,
  issueSignedToken,
  presignUrl,
  put as putBlob,
} from "@vercel/blob";
import type { ObjectStorage } from "./index";

/**
 * Vercel Blob adapter for a private store. The access flag must match the
 * store's immutable access mode, so a mistakenly public store fails closed.
 */
export class VercelBlobStorage implements ObjectStorage {
  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await putBlob(key, Buffer.from(body), {
      access: "private",
      addRandomSuffix: false,
      // A database transaction may retry the same immutable UUID key after a
      // slug collision. Replacing it with the same bytes keeps that retry safe.
      allowOverwrite: true,
      contentType,
    });
  }

  async putIfAbsent(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await putBlob(key, Buffer.from(body), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType,
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const result = await getBlob(key, { access: "private" });
    if (!result || result.statusCode !== 200) return null;

    const bytes = await new Response(result.stream).arrayBuffer();
    return new Uint8Array(bytes);
  }

  async createUploadTarget(input: {
    key: string;
    contentType: string;
    sizeBytes: number;
    expiresAt: Date;
    callbackUrl?: string;
    callbackPayload?: string;
  }) {
    const token = await issueSignedToken({
      pathname: input.key,
      operations: ["put"],
      validUntil: input.expiresAt.getTime(),
      allowedContentTypes: [input.contentType],
      maximumSizeInBytes: input.sizeBytes,
    });
    const { presignedUrl } = await presignUrl(token, {
      access: "private",
      operation: "put",
      pathname: input.key,
      validUntil: input.expiresAt.getTime(),
      allowedContentTypes: [input.contentType],
      maximumSizeInBytes: input.sizeBytes,
      allowOverwrite: false,
      addRandomSuffix: false,
      ...(input.callbackUrl
        ? {
            onUploadCompleted: {
              callbackUrl: input.callbackUrl,
              tokenPayload: input.callbackPayload,
            },
          }
        : {}),
    });
    return {
      method: "PUT" as const,
      url: presignedUrl,
      headers: { "content-type": input.contentType },
    };
  }

  async head(key: string) {
    try {
      const result = await headBlob(key);
      return {
        size: result.size,
        contentType: result.contentType,
        etag: result.etag,
      };
    } catch (error) {
      if (error instanceof BlobNotFoundError) return null;
      throw error;
    }
  }

  async open(key: string, range?: { start: number; end: number }) {
    const result = await getBlob(key, {
      access: "private",
      headers: range ? { Range: `bytes=${range.start}-${range.end}` } : undefined,
    });
    if (!result || result.statusCode === 304 || !result.stream) return null;
    return {
      size: Number(result.headers.get("content-length") ?? result.blob.size),
      contentType: result.headers.get("content-type") ?? result.blob.contentType,
      etag: result.headers.get("etag") ?? result.blob.etag,
      body: result.stream,
      contentRange: result.headers.get("content-range"),
    };
  }

  async copy(sourceKey: string, destinationKey: string, contentType: string): Promise<void> {
    await copyBlob(sourceKey, destinationKey, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType,
    });
  }

  async delete(key: string): Promise<void> {
    await deleteBlob(key);
  }
}
