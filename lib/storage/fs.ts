import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

  async put(key: string, body: Uint8Array): Promise<void> {
    const filePath = this.pathFor(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, body);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
