import { FsStorage } from "./fs";
import { R2Storage } from "./r2";
import { VercelBlobStorage } from "./vercel-blob";

export type DirectUploadTarget = {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
};

export type StorageObjectMetadata = {
  size: number;
  contentType: string | null;
  etag: string | null;
};

export type StorageOpenResult = StorageObjectMetadata & {
  body: ReadableStream<Uint8Array>;
  contentRange: string | null;
};

export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Returns null when the object does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  createUploadTarget(input: {
    key: string;
    contentType: string;
    sizeBytes: number;
    expiresAt: Date;
    callbackUrl?: string;
    callbackPayload?: string;
    localUploadUrl?: string;
  }): Promise<DirectUploadTarget>;
  head(key: string): Promise<StorageObjectMetadata | null>;
  open(key: string, range?: { start: number; end: number }): Promise<StorageOpenResult | null>;
  copy(sourceKey: string, destinationKey: string, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

let cachedStorage: ObjectStorage | undefined;

export type StorageDriver = "fs" | "r2" | "vercel-blob";

export function resolveStorageDriver(): StorageDriver {
  const configured = process.env.STORAGE_DRIVER?.trim().toLowerCase();
  if (configured) {
    if (configured === "blob") return "vercel-blob";
    if (configured === "fs" || configured === "r2" || configured === "vercel-blob") {
      return configured;
    }
    throw new Error(`Unsupported STORAGE_DRIVER "${configured}". Expected fs, r2, or vercel-blob.`);
  }

  // A Deploy Button-provisioned Blob store provides one of these. Do not use
  // VERCEL alone: existing Vercel deployments may intentionally use R2.
  if (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID) {
    return "vercel-blob";
  }
  return "r2";
}

export function getStorage(): ObjectStorage {
  if (!cachedStorage) {
    const driver = resolveStorageDriver();
    if (driver === "fs") {
      if (process.env.NODE_ENV === "production") {
        throw new Error("STORAGE_DRIVER=fs is disabled in production");
      }
      cachedStorage = new FsStorage(process.env.STORAGE_FS_ROOT ?? ".data/storage");
    } else if (driver === "vercel-blob") {
      cachedStorage = new VercelBlobStorage();
    } else {
      cachedStorage = new R2Storage();
    }
  }
  return cachedStorage;
}

export function storageKeyFor(
  ownerId: string,
  draftId: string,
  versionId: string,
  extension = ".html",
): string {
  return `drafts/${ownerId}/${draftId}/${versionId}${extension}`;
}

export function stagingKeyFor(ownerId: string, intentId: string, extension: string): string {
  return `staging/${ownerId}/${intentId}${extension}`;
}
