import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

// Must be configured before the lazy storage/db singletons are first used.
const storageRoot = mkdtempSync(path.join(os.tmpdir(), "agentplan-limits-"));
process.env.STORAGE_DRIVER = "fs";
process.env.STORAGE_FS_ROOT = storageRoot;

import { closeDb, getDb } from "@/db/client";
import { listVersions } from "@/db/queries/drafts";
import { eq, sql } from "drizzle-orm";
import { drafts, rateLimits, users, type UserPlan } from "@/db/schema";
import { addVersionToDraft, createDraftWithFirstVersion } from "@/lib/drafts/service";
import { QuotaExceededError, RateLimitedError } from "@/lib/limits/errors";
import { consumeRateLimit, consumeRateLimits } from "@/lib/limits/rate-limit";
import { createToken, revokeToken } from "@/lib/tokens/service";

const hasDb = Boolean(process.env.DATABASE_URL);
const html = new TextEncoder().encode("<!doctype html><h1>limits</h1>");

const LIMIT_ENV_VARS = [
  "AP_MAX_DRAFTS_PER_USER",
  "AP_MAX_VERSIONS_PER_DRAFT",
  "AP_MAX_STORAGE_BYTES_PER_USER",
  "AP_MAX_ACTIVE_TOKENS_PER_USER",
  "AP_UPLOADS_PER_10MIN",
  "AP_UPLOADS_PER_DAY",
];

async function createUser(plan: UserPlan = "free"): Promise<string> {
  const id = `limit-user-${randomUUID()}`;
  await getDb()
    .insert(users)
    .values({ id, name: "Limit User", email: `${id}@example.test`, emailVerified: true, plan });
  return id;
}

async function filesUnder(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

describe.skipIf(!hasDb)("abuse limits (integration)", () => {
  afterEach(() => {
    for (const name of LIMIT_ENV_VARS) delete process.env[name];
  });

  afterAll(async () => {
    await closeDb();
  });

  it("rate limiter allows up to the limit, then rejects with a retry-after", async () => {
    const key = `test:${randomUUID()}`;
    expect(await consumeRateLimit({ key, limit: 2, windowSeconds: 3600 })).toEqual({ ok: true });
    expect(await consumeRateLimit({ key, limit: 2, windowSeconds: 3600 })).toEqual({ ok: true });

    const third = await consumeRateLimit({ key, limit: 2, windowSeconds: 3600 });
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.retryAfterSeconds).toBeGreaterThan(0);
      expect(third.retryAfterSeconds).toBeLessThanOrEqual(3600);
    }
  });

  it("rolls back shorter-window usage when another window is closed", async () => {
    const suffix = randomUUID();
    const shortKey = `test:short:${suffix}`;
    const dailyKey = `test:daily:${suffix}`;
    await consumeRateLimit({ key: dailyKey, limit: 1, windowSeconds: 86_400 });

    const result = await consumeRateLimits([
      { key: shortKey, limit: 10, windowSeconds: 600 },
      { key: dailyKey, limit: 1, windowSeconds: 86_400 },
    ]);
    expect(result.ok).toBe(false);

    const [short] = await getDb()
      .select({ count: rateLimits.count })
      .from(rateLimits)
      .where(eq(rateLimits.key, shortKey));
    expect(short).toBeUndefined();
  });

  it("enforces the per-user draft cap", async () => {
    process.env.AP_MAX_DRAFTS_PER_USER = "2";
    const ownerId = await createUser();
    const create = () =>
      createDraftWithFirstVersion({
        ownerId,
        title: "Capped",
        visibility: "private",
        bytes: html,
        source: "browser",
      });

    await create();
    await create();
    await expect(create()).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("serializes concurrent draft quota checks with their inserts", async () => {
    process.env.AP_MAX_DRAFTS_PER_USER = "1";
    const ownerId = await createUser();
    const create = (title: string) =>
      createDraftWithFirstVersion({
        ownerId,
        title,
        visibility: "private",
        bytes: html,
        source: "browser",
      });

    const results = await Promise.allSettled([create("Concurrent A"), create("Concurrent B")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      results.filter(
        (result) => result.status === "rejected" && result.reason instanceof QuotaExceededError,
      ),
    ).toHaveLength(1);

    const [row] = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(drafts)
      .where(eq(drafts.ownerId, ownerId));
    expect(row?.count).toBe(1);
  });

  it("enforces the per-user storage quota", async () => {
    process.env.AP_MAX_STORAGE_BYTES_PER_USER = String(html.byteLength + 5);
    const ownerId = await createUser();

    const { draft } = await createDraftWithFirstVersion({
      ownerId,
      title: "Storage",
      visibility: "private",
      bytes: html,
      source: "browser",
    });
    await expect(
      addVersionToDraft({ draft, bytes: html, source: "browser" }),
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("prunes the oldest versions past the retention count instead of failing", async () => {
    process.env.AP_MAX_VERSIONS_PER_DRAFT = "2";
    const ownerId = await createUser();

    const { draft } = await createDraftWithFirstVersion({
      ownerId,
      title: "Pruned",
      visibility: "private",
      bytes: html,
      source: "browser",
    });
    await addVersionToDraft({ draft, bytes: html, source: "browser" });
    const { version: v3 } = await addVersionToDraft({ draft, bytes: html, source: "browser" });

    expect(v3.versionNumber).toBe(3);
    const versions = await listVersions(draft.id);
    expect(versions.map((v) => v.versionNumber)).toEqual([3, 2]);

    // The pruned version's object is gone from storage too.
    const stored = await filesUnder(path.join(storageRoot, "drafts", ownerId, draft.id));
    expect(stored).toHaveLength(2);
  });

  it("rate limits uploads per user", async () => {
    process.env.AP_UPLOADS_PER_10MIN = "2";
    const ownerId = await createUser();

    const { draft } = await createDraftWithFirstVersion({
      ownerId,
      title: "Bursty",
      visibility: "private",
      bytes: html,
      source: "browser",
    });
    await addVersionToDraft({ draft, bytes: html, source: "browser" });
    await expect(
      addVersionToDraft({ draft, bytes: html, source: "browser" }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("unlimited plan bypasses caps, quotas, rate limits, and pruning", async () => {
    process.env.AP_MAX_DRAFTS_PER_USER = "1";
    process.env.AP_MAX_VERSIONS_PER_DRAFT = "1";
    process.env.AP_MAX_STORAGE_BYTES_PER_USER = "1";
    process.env.AP_UPLOADS_PER_10MIN = "1";
    const ownerId = await createUser("unlimited");

    const { draft } = await createDraftWithFirstVersion({
      ownerId,
      title: "Unlimited",
      visibility: "private",
      bytes: html,
      source: "browser",
    });
    await createDraftWithFirstVersion({
      ownerId,
      title: "Unlimited 2",
      visibility: "private",
      bytes: html,
      source: "browser",
    });
    await addVersionToDraft({ draft, bytes: html, source: "browser" });

    const versions = await listVersions(draft.id);
    expect(versions.map((v) => v.versionNumber)).toEqual([2, 1]);
  });

  it("caps active tokens and frees the slot on revocation", async () => {
    process.env.AP_MAX_ACTIVE_TOKENS_PER_USER = "1";
    const userId = await createUser();

    const first = await createToken({ userId, name: "one", scopes: ["drafts:read"] });
    await expect(
      createToken({ userId, name: "two", scopes: ["drafts:read"] }),
    ).rejects.toBeInstanceOf(QuotaExceededError);

    await revokeToken(userId, first.record.id);
    await expect(
      createToken({ userId, name: "two", scopes: ["drafts:read"] }),
    ).resolves.toBeDefined();
  });

  it("falls back to defaults for unparseable limit overrides", async () => {
    process.env.AP_MAX_DRAFTS_PER_USER = "not-a-number";
    const ownerId = await createUser();
    await expect(
      createDraftWithFirstVersion({
        ownerId,
        title: "Default limits",
        visibility: "private",
        bytes: html,
        source: "browser",
      }),
    ).resolves.toBeDefined();
  });
});
