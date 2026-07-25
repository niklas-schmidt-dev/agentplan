import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getStorage, resolveStorageDriver } from "@/lib/storage";

const live = process.env.LIVE_STORAGE_CONTRACT === "1";

describe.skipIf(!live)("live private storage contract", () => {
  it("enforces immutable direct PUTs, reads ranges, copies, and deletes", async () => {
    const storage = getStorage();
    const driver = resolveStorageDriver();
    expect(driver === "r2" || driver === "vercel-blob").toBe(true);
    const id = randomUUID();
    const sourceKey = `contract-tests/${id}/source.mp4`;
    const copyKey = `contract-tests/${id}/copy.mp4`;
    const bytes = new Uint8Array([
      0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 105, 115,
      111, 50,
    ]);
    try {
      const target = await storage.createUploadTarget({
        key: sourceKey,
        contentType: "video/mp4",
        sizeBytes: bytes.byteLength,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const headers = new Headers(target.headers);
      headers.set("content-length", String(bytes.byteLength));
      const first = await fetch(target.url, {
        method: target.method,
        headers,
        body: bytes,
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      expect(first.ok).toBe(true);
      const replay = await fetch(target.url, {
        method: target.method,
        headers,
        body: new Uint8Array(bytes.map((value) => value ^ 0xff)),
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      expect(replay.ok).toBe(false);

      await expect(storage.head(sourceKey)).resolves.toMatchObject({
        size: bytes.byteLength,
        contentType: "video/mp4",
      });
      const partial = await storage.open(sourceKey, { start: 4, end: 7 });
      expect(partial?.contentRange).toBe(`bytes 4-7/${bytes.byteLength}`);
      expect(await new Response(partial!.body).text()).toBe("ftyp");

      await storage.copy(sourceKey, copyKey, "video/mp4");
      await expect(storage.head(copyKey)).resolves.toMatchObject({
        size: bytes.byteLength,
        contentType: "video/mp4",
      });
    } finally {
      await Promise.allSettled([storage.delete(sourceKey), storage.delete(copyKey)]);
    }
    await expect(storage.head(sourceKey)).resolves.toBeNull();
    await expect(storage.head(copyKey)).resolves.toBeNull();
  }, 60_000);
});
