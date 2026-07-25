import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const blobMocks = vi.hoisted(() => ({
  put: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
  head: vi.fn(),
  copy: vi.fn(),
  issueSignedToken: vi.fn(),
  presignUrl: vi.fn(),
}));

vi.mock("@vercel/blob", () => blobMocks);

import { resolveStorageDriver } from "@/lib/storage";
import { FsStorage } from "@/lib/storage/fs";
import { VercelBlobStorage } from "@/lib/storage/vercel-blob";

describe("storage driver selection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("automatically selects Blob only when a Blob store is connected", () => {
    vi.stubEnv("STORAGE_DRIVER", "");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_example");
    expect(resolveStorageDriver()).toBe("vercel-blob");

    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("BLOB_STORE_ID", "");
    vi.stubEnv("VERCEL", "1");
    expect(resolveStorageDriver()).toBe("r2");
  });

  it("rejects unknown drivers", () => {
    vi.stubEnv("STORAGE_DRIVER", "public-blob");
    expect(() => resolveStorageDriver()).toThrow(/Unsupported STORAGE_DRIVER/);
  });
});

describe("VercelBlobStorage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("writes deterministic paths only to private Blob storage", async () => {
    blobMocks.put.mockResolvedValue({ pathname: "drafts/user/draft/version.html" });
    const storage = new VercelBlobStorage();
    const bytes = new TextEncoder().encode("<h1>private</h1>");

    await storage.put("drafts/user/draft/version.html", bytes, "text/html; charset=utf-8");

    expect(blobMocks.put).toHaveBeenCalledWith(
      "drafts/user/draft/version.html",
      expect.any(Buffer),
      {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "text/html; charset=utf-8",
      },
    );
  });

  it("reads and deletes private blobs by storage key", async () => {
    const bytes = new TextEncoder().encode("<p>stored</p>");
    blobMocks.get.mockResolvedValue({
      statusCode: 200,
      stream: new Blob([bytes]).stream(),
    });
    blobMocks.del.mockResolvedValue(undefined);
    const storage = new VercelBlobStorage();

    const stored = await storage.get("drafts/version.html");
    expect(stored).not.toBeNull();
    expect(new TextDecoder().decode(stored!)).toBe("<p>stored</p>");
    expect(blobMocks.get).toHaveBeenCalledWith("drafts/version.html", { access: "private" });

    await storage.delete("drafts/version.html");
    expect(blobMocks.del).toHaveBeenCalledWith("drafts/version.html");
  });

  it("returns null when a blob does not exist", async () => {
    blobMocks.get.mockResolvedValue(null);
    await expect(new VercelBlobStorage().get("missing.html")).resolves.toBeNull();
  });

  it("scopes direct uploads and copies to immutable final paths", async () => {
    blobMocks.issueSignedToken.mockResolvedValue("signed-token");
    blobMocks.presignUrl.mockResolvedValue({ presignedUrl: "https://blob.example/upload" });
    blobMocks.copy.mockResolvedValue(undefined);
    const storage = new VercelBlobStorage();
    const expiresAt = new Date(Date.now() + 60_000);

    await expect(
      storage.createUploadTarget({
        key: "staging/user/intent.png",
        contentType: "image/png",
        sizeBytes: 1234,
        expiresAt,
        callbackUrl: "https://agentplan.example/api/v1/uploads/vercel-callback",
        callbackPayload: "bound-token",
      }),
    ).resolves.toMatchObject({
      method: "PUT",
      url: "https://blob.example/upload",
      headers: { "content-type": "image/png" },
    });
    expect(blobMocks.issueSignedToken).toHaveBeenCalledWith({
      pathname: "staging/user/intent.png",
      operations: ["put"],
      validUntil: expiresAt.getTime(),
      allowedContentTypes: ["image/png"],
      maximumSizeInBytes: 1234,
    });
    expect(blobMocks.presignUrl).toHaveBeenCalledWith(
      "signed-token",
      expect.objectContaining({
        operation: "put",
        pathname: "staging/user/intent.png",
        allowOverwrite: false,
        addRandomSuffix: false,
      }),
    );

    await storage.copy("staging/user/intent.png", "drafts/user/draft/version.png", "image/png");
    expect(blobMocks.copy).toHaveBeenCalledWith(
      "staging/user/intent.png",
      "drafts/user/draft/version.png",
      {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: "image/png",
      },
    );
  });
});

describe("FsStorage media contract", () => {
  it("heads, copies, streams, ranges, and deletes objects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentplan-storage-"));
    try {
      const storage = new FsStorage(root);
      const bytes = new TextEncoder().encode("0123456789");
      await storage.put("staging/file.mp4", bytes, "video/mp4");
      await expect(storage.head("staging/file.mp4")).resolves.toMatchObject({ size: 10 });
      await storage.copy("staging/file.mp4", "drafts/final.mp4", "video/mp4");
      await expect(
        storage.copy("staging/file.mp4", "drafts/final.mp4", "video/mp4"),
      ).rejects.toThrow();

      const partial = await storage.open("drafts/final.mp4", { start: 2, end: 5 });
      expect(partial?.contentRange).toBe("bytes 2-5/10");
      expect(await new Response(partial!.body).text()).toBe("2345");

      await storage.delete("drafts/final.mp4");
      await expect(storage.head("drafts/final.mp4")).resolves.toBeNull();
      await storage.delete("drafts/final.mp4");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
