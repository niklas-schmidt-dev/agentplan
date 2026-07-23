import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// Must be configured before the lazy storage/db singletons are first used.
const storageRoot = mkdtempSync(path.join(os.tmpdir(), "agentplan-admin-"));
process.env.STORAGE_DRIVER = "fs";
process.env.STORAGE_FS_ROOT = storageRoot;

import { and, eq, inArray, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { appSettings, auditEvents, drafts, users } from "@/db/schema";
import {
  deleteUserCompletely,
  getAdminStats,
  listUsersWithUsage,
  purgePendingUserDeletionObjects,
  setUserRole,
} from "@/lib/admin/service";
import { evaluateSignup, SignupsDisabledError } from "@/lib/auth/signup-policy";
import { addVersionToDraft, createDraftWithFirstVersion } from "@/lib/drafts/service";
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
    .values({
      id,
      name: "Admin Test User",
      email: `${id}@example.test`,
      emailVerified: true,
      role: "admin",
    });
  createdUserIds.push(id);
  return id;
}

async function makeAdmin(userId: string): Promise<void> {
  await getDb().update(users).set({ role: "admin" }).where(eq(users.id, userId));
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
    const actorId = await createUser();
    await makeAdmin(actorId);
    await getDb().delete(appSettings).where(eq(appSettings.key, "signups_enabled"));
    expect(await getSignupsEnabled()).toBe(true);

    await setSignupsEnabled({ userId: actorId }, false);
    expect(await getSignupsEnabled()).toBe(false);

    await setSignupsEnabled({ userId: actorId }, true);
    expect(await getSignupsEnabled()).toBe(true);
  });

  it("evaluateSignup blocks new users while signups are disabled", async () => {
    // Ensure the users table is non-empty so the first-user path can't apply.
    const actorId = await createUser();
    await makeAdmin(actorId);

    await setSignupsEnabled({ userId: actorId }, false);
    await expect(evaluateSignup("candidate@example.test")).rejects.toThrow(SignupsDisabledError);

    await setSignupsEnabled({ userId: actorId }, true);
    await expect(evaluateSignup("candidate@example.test")).resolves.toEqual({ role: "user" });
  });

  it("setUserRole promotes and demotes, but never the actor themselves", async () => {
    const actorId = await createUser();
    const targetId = await createUser();
    await makeAdmin(actorId);

    await setUserRole({ userId: actorId }, targetId, "admin");
    let [target] = await getDb().select().from(users).where(eq(users.id, targetId));
    expect(target?.role).toBe("admin");

    await setUserRole({ userId: actorId }, targetId, "user");
    [target] = await getDb().select().from(users).where(eq(users.id, targetId));
    expect(target?.role).toBe("user");

    await expect(setUserRole({ userId: actorId }, actorId, "admin")).rejects.toThrow(/own role/);
    await expect(
      setUserRole({ userId: actorId }, "missing-admin-test-user", "admin"),
    ).rejects.toThrow(/not found/);
  });

  it("serializes concurrent demotions so an admin always remains", async () => {
    const firstAdminId = await createUser();
    const secondAdminId = await createUser();
    await makeAdmin(firstAdminId);
    await makeAdmin(secondAdminId);

    const results = await Promise.allSettled([
      setUserRole({ userId: firstAdminId }, secondAdminId, "user"),
      setUserRole({ userId: secondAdminId }, firstAdminId, "user"),
    ]);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const remaining = await getDb()
      .select({ role: users.role })
      .from(users)
      .where(inArray(users.id, [firstAdminId, secondAdminId]));
    expect(remaining.filter((row) => row.role === "admin")).toHaveLength(1);
  });

  it("deleteUserCompletely removes the user, their rows, and their stored objects", async () => {
    const adminId = await createUser();
    const victimId = await createUser();
    await makeAdmin(adminId);
    const { version } = await createDraftWithFirstVersion({
      ownerId: victimId,
      title: "Doomed draft",
      visibility: "private",
      bytes: html,
      source: "browser",
    });
    await createToken({ userId: victimId, name: "doomed", scopes: ["drafts:write"] });
    expect(await getStorage().get(version.storageKey)).not.toBeNull();

    await expect(deleteUserCompletely({ userId: adminId }, adminId)).rejects.toThrow(/own account/);

    await deleteUserCompletely({ userId: adminId }, victimId);
    const [gone] = await getDb().select().from(users).where(eq(users.id, victimId));
    expect(gone).toBeUndefined();
    const ownedDrafts = await getDb().select().from(drafts).where(eq(drafts.ownerId, victimId));
    expect(ownedDrafts).toHaveLength(0);
    expect(await getStorage().get(version.storageKey)).toBeNull();

    // Deleting a user that no longer exists is a no-op, not an error.
    await expect(deleteUserCompletely({ userId: adminId }, victimId)).resolves.toBeUndefined();
  });

  it("serializes an in-flight upload with account deletion so no object is orphaned", async () => {
    const adminId = await createUser();
    const victimId = await createUser();
    await makeAdmin(adminId);
    const storage = getStorage();
    const realPut = storage.put.bind(storage);
    let releasePut!: () => void;
    let markPutStarted!: () => void;
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const putStarted = new Promise<void>((resolve) => {
      markPutStarted = resolve;
    });
    const putSpy = vi
      .spyOn(storage, "put")
      .mockImplementation(async (key, body, contentType) => {
        markPutStarted();
        await putGate;
        await realPut(key, body, contentType);
      });

    try {
      const upload = createDraftWithFirstVersion({
        ownerId: victimId,
        title: "Racing deletion",
        visibility: "private",
        bytes: html,
        source: "browser",
      });
      await putStarted;

      let deletionSettled = false;
      const deletion = deleteUserCompletely({ userId: adminId }, victimId).finally(() => {
        deletionSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(deletionSettled).toBe(false);

      releasePut();
      const [{ version }] = await Promise.all([upload, deletion]);
      expect(await storage.get(version.storageKey)).toBeNull();
      const [gone] = await getDb().select().from(users).where(eq(users.id, victimId));
      expect(gone).toBeUndefined();
    } finally {
      releasePut();
      putSpy.mockRestore();
    }
  });

  it("rechecks the actor's current role before deleting", async () => {
    const actorId = await createUser();
    const targetId = await createUser();
    await makeAdmin(actorId);
    await makeAdmin(targetId);

    await setUserRole({ userId: actorId }, targetId, "user");
    await expect(deleteUserCompletely({ userId: targetId }, actorId)).rejects.toThrow(
      /current admins/,
    );
    await expect(deleteUserCompletely({ userId: actorId }, targetId)).resolves.toBeUndefined();

    const [remainingAdmin] = await getDb()
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, actorId));
    expect(remainingAdmin?.role).toBe("admin");
  });

  it("queues partial storage cleanup without leaving a live user with broken drafts", async () => {
    const adminId = await createUser();
    const victimId = await createUser();
    await makeAdmin(adminId);
    const { draft, version: firstVersion } = await createDraftWithFirstVersion({
      ownerId: victimId,
      title: "Partially doomed draft",
      visibility: "private",
      bytes: html,
      source: "browser",
    });
    const { version: secondVersion } = await addVersionToDraft({
      draft,
      bytes: html,
      source: "browser",
    });

    const storage = getStorage();
    const realDelete = storage.delete.bind(storage);
    let attempts = 0;
    const deleteSpy = vi.spyOn(storage, "delete").mockImplementation(async (key) => {
      attempts++;
      if (attempts === 2) throw new Error("simulated partial storage outage");
      await realDelete(key);
    });

    try {
      await deleteUserCompletely({ userId: adminId }, victimId);
    } finally {
      deleteSpy.mockRestore();
    }
    const [gone] = await getDb().select().from(users).where(eq(users.id, victimId));
    expect(gone).toBeUndefined();
    const [pending] = await getDb()
      .select({
        id: auditEvents.id,
        userId: auditEvents.userId,
        metadata: auditEvents.metadata,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "user.deletion_pending"),
          sql`${auditEvents.metadata}->>'targetUserId' = ${victimId}`,
        ),
      );
    expect(pending).toBeDefined();
    expect(pending?.userId).toBe(adminId);
    expect(pending?.metadata).toEqual(
      expect.objectContaining({
        targetUserId: victimId,
        storageKeys: expect.arrayContaining([firstVersion.storageKey, secondVersion.storageKey]),
        storageCleanup: "pending",
      }),
    );
    expect(JSON.stringify(pending?.metadata)).not.toContain(`${victimId}@example.test`);
    expect(JSON.stringify(pending?.metadata)).not.toContain(`${adminId}@example.test`);

    await expect(purgePendingUserDeletionObjects()).resolves.toEqual(
      expect.objectContaining({ purged: expect.any(Number), failed: 0 }),
    );
    expect(await storage.get(firstVersion.storageKey)).toBeNull();
    expect(await storage.get(secondVersion.storageKey)).toBeNull();
    const [completed] = await getDb()
      .select({
        eventType: auditEvents.eventType,
        metadata: auditEvents.metadata,
      })
      .from(auditEvents)
      .where(eq(auditEvents.id, pending!.id));
    expect(completed?.eventType).toBe("user.deleted");
    expect(completed?.metadata).toEqual({
      storageCleanup: "complete",
      objectsDeleted: 2,
    });
  });

  it("rejects signup changes from a demoted admin's stale session", async () => {
    const currentAdminId = await createUser();
    const staleAdminId = await createUser();
    await makeAdmin(currentAdminId);
    await makeAdmin(staleAdminId);

    await setUserRole({ userId: currentAdminId }, staleAdminId, "user");
    await expect(setSignupsEnabled({ userId: staleAdminId }, false)).rejects.toThrow(
      /current admins/,
    );
    expect(await getSignupsEnabled()).toBe(true);
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

    const row = (
      await listUsersWithUsage({
        limit: 100,
        offset: Math.max(stats.users - 100, 0),
      })
    ).find((candidate) => candidate.id === userId);
    expect(row).toBeDefined();
    expect(row?.draftCount).toBe(1);
    expect(row?.storageBytes).toBe(html.byteLength);
    expect(row?.tokenCount).toBe(1);
  });
});
