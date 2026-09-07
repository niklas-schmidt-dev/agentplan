import { describe, expect, it, vi } from "vitest";
import { storageResponseMatches } from "@/lib/http/storage-metadata";
import { drainBatches } from "@/lib/maintenance/drain";
import { mapWithConcurrency } from "@/lib/uploads/concurrency";
import type { StorageOpenResult } from "@/lib/storage";

describe("bounded upload and maintenance work", () => {
  it("joins active workers and stops admission after failure", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const visited: number[] = [];
    let settled = false;
    const work = mapWithConcurrency([0, 1, 2, 3], 2, async (value) => {
      visited.push(value);
      if (value === 0) throw new Error("bad object");
      await gate;
      return value;
    });
    const outcome = work.catch((error) => {
      settled = true;
      return error;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect(await outcome).toMatchObject({ message: "bad object" });
    expect(visited).toEqual([0, 1]);
  });

  it("drains multiple batches and admits no work after the deadline", async () => {
    const batch = vi
      .fn()
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(100)
      .mockResolvedValue(0);
    expect(await drainBatches(batch, Date.now() + 1000)).toBe(200);
    expect(batch).toHaveBeenCalledTimes(3);
    expect(await drainBatches(batch, Date.now() - 1)).toBe(0);
    expect(batch).toHaveBeenCalledTimes(3);
  });

  it("validates full and partial GET metadata without a preparatory HEAD", () => {
    const expected = { sizeBytes: 100, contentType: "video/mp4" };
    const object: StorageOpenResult = {
      size: 100,
      contentType: "video/mp4",
      contentRange: null,
      etag: null,
      body: new ReadableStream(),
    };
    expect(storageResponseMatches(object, expected)).toBe(true);
    expect(storageResponseMatches({ ...object, size: 99 }, expected)).toBe(false);
    expect(storageResponseMatches({ ...object, contentType: "text/html" }, expected)).toBe(false);
    const partial = { ...object, size: 10, contentRange: "bytes 10-19/100" };
    expect(storageResponseMatches(partial, expected, { start: 10, end: 19 })).toBe(true);
    expect(storageResponseMatches(partial, expected)).toBe(false);
    expect(
      storageResponseMatches({ ...partial, contentRange: "bytes 10-19/200" }, expected, {
        start: 10,
        end: 19,
      }),
    ).toBe(false);
    expect(storageResponseMatches(object, expected, { start: 10, end: 19 })).toBe(false);
  });
});
