import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import type { ObjectStorage } from "./index";

/** Dev/test-only driver; see getStorage(). Keys are sanitized onto a root dir. */
export class FsStorage implements ObjectStorage {
  constructor(private root: string) {}

  private pathFor(key: string): string {
    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(path.resolve(this.root) + path.sep)) {
      throw new Error(`Storage key escapes root: ${key}`);
    }
    return resolved;
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    void contentType;
    const filePath = this.pathFor(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, body);
  }

  async putIfAbsent(key: string, body: Uint8Array, contentType: string): Promise<void> {
    void contentType;
    const filePath = this.pathFor(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, body, { flag: "wx" });
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async createUploadTarget(input: {
    localUploadUrl?: string;
    contentType: string;
  }): Promise<{ method: "PUT"; url: string; headers: Record<string, string> }> {
    if (!input.localUploadUrl) throw new Error("Filesystem uploads require a local upload URL");
    return {
      method: "PUT",
      url: input.localUploadUrl,
      headers: { "content-type": input.contentType },
    };
  }

  async head(key: string) {
    try {
      const metadata = await stat(this.pathFor(key));
      return { size: metadata.size, contentType: null, etag: null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async open(key: string, range?: { start: number; end: number }) {
    const metadata = await this.head(key);
    if (!metadata) return null;
    const nodeStream = createReadStream(this.pathFor(key), range);
    return {
      ...metadata,
      body: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
      contentRange: range ? `bytes ${range.start}-${range.end}/${metadata.size}` : null,
    };
  }

  async copy(sourceKey: string, destinationKey: string, contentType: string): Promise<void> {
    void contentType;
    const destination = this.pathFor(destinationKey);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(this.pathFor(sourceKey), destination, constants.COPYFILE_EXCL);
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
