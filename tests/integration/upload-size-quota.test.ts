import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

process.env.STORAGE_DRIVER = "fs";
process.env.STORAGE_FS_ROOT = mkdtempSync(path.join(os.tmpdir(), "agentplan-size-quota-"));
process.env.BETTER_AUTH_SECRET ??= "upload-size-quota-test-secret";

import { POST as createIntentRoute } from "@/app/api/v1/uploads/intents/route";
import { PUT as uploadBodyRoute } from "@/app/api/v1/uploads/intents/[id]/body/route";
import { POST as completeIntentRoute } from "@/app/api/v1/uploads/intents/[id]/complete/route";
import { GET as getContent } from "@/app/p/[slug]/content/route";
import { closeDb, getDb } from "@/db/client";
import { draftVersions, users, type UserPlan } from "@/db/schema";
import { listDraftsForOwner } from "@/db/queries/drafts";
import { listDraftsForAdmin } from "@/lib/admin/service";
import { getUserStorageUsage } from "@/lib/limits/enforce";
import { QuotaExceededError } from "@/lib/limits/errors";
import { getStorage } from "@/lib/storage";
import { createToken } from "@/lib/tokens/service";
import { createBundleUpload, getBundleForOwner } from "@/lib/uploads/bundles";
import {
  cancelUploadIntent,
  completeUploadIntent,
  createUploadIntent,
} from "@/lib/uploads/service";

const MiB = 1024 ** 2;
const hasDb = Boolean(process.env.DATABASE_URL);
const owners: string[] = [];

async function owner(plan: UserPlan = "free") {
  const id = `size-quota-${randomUUID()}`;
  await getDb()
    .insert(users)
    .values({
      id,
      name: "Upload size test",
      email: `${id}@example.test`,
      emailVerified: true,
      role: "admin",
      plan,
    });
  owners.push(id);
  return id;
}

function intentInput(ownerId: string, sizeBytes: number, filename = "plan.html") {
  return {
    ownerId,
    sizeBytes,
    filename,
    contentType: filename.endsWith(".mp4") ? "video/mp4" : "text/html",
    source: "api_token" as const,
    baseUrl: "http://localhost:3000",
    target: { type: "new" as const, visibility: "private" as const },
  };
}

describe.skipIf(!hasDb)("upload sizes governed by storage quota", () => {
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    for (const id of owners) await getDb().delete(users).where(eq(users.id, id));
    await closeDb();
  });

  it("uploads and versions HTML above 2 MiB through authenticated direct-upload routes", async () => {
    const userId = await owner();
    const token = await createToken({ userId, name: "upload", scopes: ["drafts:write"] });
    const bytes = new TextEncoder().encode(
      "<!doctype html><h1>Large plan</h1>" + " ".repeat(3 * MiB),
    );
    const headers = { authorization: `Bearer ${token.token}`, "content-type": "application/json" };
    let draftId: string | undefined;
    for (let version = 1; version <= 2; version++) {
      const response = await createIntentRoute(
        new Request("http://localhost:3000/api/v1/uploads/intents", {
          method: "POST",
          headers,
          body: JSON.stringify({
            filename: "plan.html",
            contentType: "text/html",
            sizeBytes: bytes.byteLength,
            target: draftId ? { type: "draft", draftId } : { type: "new", visibility: "public" },
          }),
        }),
      );
      expect(response.status).toBe(201);
      const created = await response.json();
      const params = { params: Promise.resolve({ id: created.intent.id as string }) };
      const uploaded = await uploadBodyRoute(
        new Request(created.upload.url, {
          method: "PUT",
          headers: { ...created.upload.headers, "content-length": String(bytes.byteLength) },
          body: bytes,
        }),
        params,
      );
      expect(uploaded.status).toBe(204);
      const completed = await completeIntentRoute(
        new Request(`http://localhost:3000/api/v1/uploads/intents/${created.intent.id}/complete`, {
          method: "POST",
          headers,
        }),
        params,
      );
      expect(completed.status).toBe(200);
      const result = await completed.json();
      draftId = result.draft.id;
      expect(result.version.sizeBytes).toBe(bytes.byteLength);
      expect(result.version.version).toBe(version);
      const content = await getContent(
        new Request(`http://localhost:3000/p/${result.draft.slug}/content`),
        {
          params: Promise.resolve({ slug: result.draft.slug as string }),
        },
      );
      expect(content.status).toBe(200);
      expect(Buffer.from(await content.arrayBuffer()).equals(bytes)).toBe(true);
    }
    expect(await getUserStorageUsage(userId)).toMatchObject({
      committedBytes: 2 * bytes.byteLength,
      reservedBytes: 0,
    });
  });

  it("counts committed bytes and pending uploads, accepting exactly the available storage", async () => {
    vi.stubEnv("AP_MAX_STORAGE_BYTES_PER_USER", String(8 * MiB));
    const userId = await owner();
    const first = await createUploadIntent(intentInput(userId, 3 * MiB));
    await getStorage().put(first.intent.stagingKey!, new Uint8Array(3 * MiB).fill(32), "text/html");
    await completeUploadIntent(first.intent.id, userId);
    const pending = await createUploadIntent(intentInput(userId, 5 * MiB));
    await expect(createUploadIntent(intentInput(userId, 1))).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
    expect(await getUserStorageUsage(userId)).toMatchObject({
      committedBytes: 3 * MiB,
      reservedBytes: 5 * MiB,
    });
    await cancelUploadIntent(userId, pending.intent.id);
    await expect(createUploadIntent(intentInput(userId, 5 * MiB + 1))).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
    await expect(createUploadIntent(intentInput(userId, 5 * MiB))).resolves.toBeDefined();
  });

  it("reserves media above 100 MiB and bundles above 125 MiB within the free quota", async () => {
    vi.stubEnv("AP_MAX_STORAGE_BYTES_PER_USER", String(300 * MiB));
    const userId = await owner();
    await createUploadIntent(intentInput(userId, 101 * MiB, "movie.mp4"));
    const bundle = await createBundleUpload({
      ownerId: userId,
      source: "browser",
      entryPath: "index.html",
      files: [
        { path: "index.html", contentType: "text/html", sizeBytes: 3 * MiB },
        { path: "hero.png", contentType: "image/png", sizeBytes: 11 * MiB },
        { path: "movie.mp4", contentType: "video/mp4", sizeBytes: 120 * MiB },
      ],
      target: { type: "new", visibility: "private" },
    });
    expect(bundle.intent.expectedBytes).toBe(134 * MiB);
    expect(await getUserStorageUsage(userId)).toMatchObject({ reservedBytes: 235 * MiB });
    await expect(createUploadIntent(intentInput(userId, 66 * MiB))).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
  });

  it("reads stored byte counts above 2 GiB in owner and admin lists", async () => {
    const userId = await owner("unlimited");
    const created = await createUploadIntent(intentInput(userId, 1));
    await getStorage().put(created.intent.stagingKey!, new Uint8Array([32]), "text/html");
    const completed = await completeUploadIntent(created.intent.id, userId);
    // Metadata fixture exercises bigint persistence and raw SQL decoders without a multi-GiB file.
    const large = 3 * 1024 ** 3;
    await getDb()
      .update(draftVersions)
      .set({ sizeBytes: large, totalSizeBytes: large })
      .where(eq(draftVersions.id, completed.version.id));
    expect((await listDraftsForOwner(userId))[0]?.currentVersion?.sizeBytes).toBe(large);
    expect(
      (await listDraftsForAdmin({ ownerId: userId })).drafts[0]?.currentVersion?.sizeBytes,
    ).toBe(large);
    expect(await getUserStorageUsage(userId)).toMatchObject({
      committedBytes: large,
      reservedBytes: 0,
    });
  });

  it("persists Unlimited reservations above 2 GiB for individual files and bundles", async () => {
    vi.stubEnv("AP_MAX_STORAGE_BYTES_PER_USER", "1");
    const userId = await owner("unlimited");
    const large = 3 * 1024 ** 3;
    const single = await createUploadIntent(intentInput(userId, large, "movie.mp4"));
    expect(single.intent.expectedBytes).toBe(large);
    const bundle = await createBundleUpload({
      ownerId: userId,
      source: "browser",
      entryPath: "index.html",
      files: [
        { path: "index.html", contentType: "text/html", sizeBytes: 3 * MiB },
        { path: "movie.mp4", contentType: "video/mp4", sizeBytes: large },
      ],
      target: { type: "new", visibility: "private" },
    });
    const stored = await getBundleForOwner(userId, bundle.intent.id);
    expect(stored?.intent.expectedBytes).toBe(large + 3 * MiB);
    expect(stored?.files[0]?.expectedBytes).toBe(large);
    expect(await getUserStorageUsage(userId)).toMatchObject({ reservedBytes: 2 * large + 3 * MiB });
  });
});
