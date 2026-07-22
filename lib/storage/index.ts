import { FsStorage } from "./fs";
import { R2Storage } from "./r2";

export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Returns null when the object does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

let cachedStorage: ObjectStorage | undefined;

/**
 * Production always uses R2. The filesystem driver exists only so local
 * development and CI can exercise the full upload/serve path without R2
 * credentials; it must never be enabled on a deployed environment.
 */
export function getStorage(): ObjectStorage {
  if (!cachedStorage) {
    cachedStorage =
      process.env.STORAGE_DRIVER === "fs" && process.env.NODE_ENV !== "production"
        ? new FsStorage(process.env.STORAGE_FS_ROOT ?? ".data/storage")
        : new R2Storage();
  }
  return cachedStorage;
}

export function storageKeyFor(ownerId: string, draftId: string, versionId: string): string {
  return `drafts/${ownerId}/${draftId}/${versionId}.html`;
}
