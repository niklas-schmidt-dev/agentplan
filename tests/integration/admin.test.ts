import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Must be configured before the lazy storage/db singletons are first used.
const storageRoot = mkdtempSync(path.join(os.tmpdir(), "agentplan-admin-"));
process.env.STORAGE_DRIVER = "fs";
process.env.STORAGE_FS_ROOT = storageRoot;

import { eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { appSettings, drafts, users } from "@/db/schema";
import {
  deleteUserCompletely,
  getAdminStats,
  listUsersWithUsage,
  setUserRole,
} from "@/lib/admin/service";
import { evaluateSignup, SignupsDisabledError } from "@/lib/auth/signup-policy";
import { createDraftWithFirstVersion } from "@/lib/drafts/service";
import { getSignupsEnabled, setSignupsEnabled } from "@/lib/settings/service";
import { getStorage } from "@/lib/storage";
import { createToken } from "@/lib/tokens/service";

const hasDb = Boolean(process.env.DATABASE_URL);
const html = new TextEncoder().encode("<!doctype html><h1>admin</h1>");

const createdUserIds: string[] = [];

async function createUser(): Promise<string> {
  const id = `admin-test-${randomUUID()}`;
  await getDb()
    .insert(users)
    .values({ id, name: "Admin Test User", email: `${id}@example.test`, emailVerified: true });
  createdUserIds.push(id);
  return id;
}

describe.skipIf(!hasDb)("admin tools (integration)", () => {
  afterAll(async () => {
    await getDb().delete(appSettings).where(eq(appSettings.key, "signups_enabled"));
    if (createdUserIds.length) {
      await getDb().delete(users).where(inArray(users.id, createdUserIds));
    }
    await closeDb();
  });

  it("signups setting defaults to enabled and round-trips the toggle", async () => {
    await getDb().delete(appSettings).where(eq(appSettings.key, "signups_enabled"));
    expect(await getSignupsEnabled()).toBe(true);

    await setSignupsEnabled(false);
    expect(await getSignupsEnabled()).toBe(false);

    await setSignupsEnabled(true);
    expect(await getSignupsEnabled()).toBe(true);
  });

  it("evaluateSignup blocks new users while signups are disabled", async () => {
    // Ensure the users table is non-empty so the first-user path can't apply.
    await createUser();

    await setSignupsEnabled(false);
    await expect(evaluateSignup()).rejects.toThrow(SignupsDisabledError);

    await setSignupsEnabled(true);
    await expect(evaluateSignup()).resolves.toEqual({ role: "user" });
  });

  it("setUserRole promotes and demotes, but never the actor themselves", async () => {
    const actorId = await createUser();
    const targetId = await createUser();

    await setUserRole({ userId: actorId }, targetId, "admin");
    let [target] = await getDb().select().from(users).where(eq(users.id, targetId));
    expect(target?.role).toBe("admin");

    await setUserRole({ userId: actorId }, targetId, "user");
    [target] = await getDb().select().from(users).where(eq(users.id, targetId));
    expect(target?.role).toBe("user");

    await expect(setUserRole({ userId: actorId }, actorId, "admin")).rejects.toThrow(
      /own role/,
    );
  });

  it("deleteUserCompletely removes the user, their rows, and their stored objects", async () => {
    const adminId = await createUser();
    const victimId = await createUser();
    const { version } = await createDraftWithFirstVersion({
      ownerId: victimId,
      title: "Doomed draft",
      visibility: "private",
      bytes: html,
      source: "browser",
    });
    await createToken({ userId: victimId, name: "doomed", scopes: ["drafts:write"] });
    expect(await getStorage().get(version.storageKey)).not.toBeNull();

    await expect(deleteUserCompletely({ userId: adminId }, adminId)).rejects.toThrow(
      /own account/,
    );

    await deleteUserCompletely({ userId: adminId }, victimId);
    const [gone] = await getDb().select().from(users).where(eq(users.id, victimId));
    expect(gone).toBeUndefined();
    const ownedDrafts = await getDb().select().from(drafts).where(eq(drafts.ownerId, victimId));
    expect(ownedDrafts).toHaveLength(0);
    expect(await getStorage().get(version.storageKey)).toBeNull();

    // Deleting a user that no longer exists is a no-op, not an error.
    await expect(deleteUserCompletely({ userId: adminId }, victimId)).resolves.toBeUndefined();
  });

  it("stats and per-user usage reflect created data", async () => {
    const userId = await createUser();
    await createDraftWithFirstVersion({
      ownerId: userId,
      title: "Stats draft",
      visibility: "private",
      bytes: html,
      source: "browser",
    });
    await createToken({ userId, name: "stats", scopes: ["drafts:write"] });

    const stats = await getAdminStats();
    expect(stats.users).toBeGreaterThanOrEqual(1);
    expect(stats.liveDrafts).toBeGreaterThanOrEqual(1);
    expect(stats.versions).toBeGreaterThanOrEqual(1);
    expect(stats.storageBytes).toBeGreaterThanOrEqual(html.byteLength);
    expect(stats.activeTokens).toBeGreaterThanOrEqual(1);

    const row = (await listUsersWithUsage()).find((candidate) => candidate.id === userId);
    expect(row).toBeDefined();
    expect(row?.draftCount).toBe(1);
    expect(row?.storageBytes).toBe(html.byteLength);
    expect(row?.tokenCount).toBe(1);
  });
});
