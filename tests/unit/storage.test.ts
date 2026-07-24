import { afterEach, describe, expect, it, vi } from "vitest";

const blobMocks = vi.hoisted(() => ({
  put: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
}));

vi.mock("@vercel/blob", () => blobMocks);

import { resolveStorageDriver } from "@/lib/storage";
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
});
