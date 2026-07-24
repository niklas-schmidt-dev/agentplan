import { del as deleteBlob, get as getBlob, put as putBlob } from "@vercel/blob";
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

  async get(key: string): Promise<Uint8Array | null> {
    const result = await getBlob(key, { access: "private" });
    if (!result || result.statusCode !== 200) return null;

    const bytes = await new Response(result.stream).arrayBuffer();
    return new Uint8Array(bytes);
  }

  async delete(key: string): Promise<void> {
    await deleteBlob(key);
  }
}
