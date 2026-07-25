import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

process.env.STORAGE_DRIVER = "fs";
process.env.STORAGE_FS_ROOT = mkdtempSync(path.join(os.tmpdir(), "agentplan-blocking-"));
process.env.BETTER_AUTH_SECRET ??= "blocking-integration-secret-not-for-production";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { POST as authPost } from "@/app/api/auth/[...all]/route";
import { getDraftBySlug } from "@/db/queries/drafts";
import { closeDb, getDb } from "@/db/client";
import {
  accounts,
  apiTokens,
  blockedOauthAccounts,
  drafts,
  sessions,
  userBlocks,
  users,
} from "@/db/schema";
import {
  blockUser,
  deleteAndBlockUser,
  deleteUserCompletely,
  listDraftsForAdmin,
  listIdentityBlocks,
  setUserPlan,
  setUserRole,
  unblockIdentityBlock,
} from "@/lib/admin/service";
import { createDraftWithFirstVersion, setDraftTitle } from "@/lib/drafts/service";
import { purgeDeletedDrafts } from "@/lib/drafts/purge";
import { getStorage } from "@/lib/storage";
import { authenticateBearer, createToken } from "@/lib/tokens/service";
import { generateApiToken } from "@/lib/tokens/token";

const hasDb = Boolean(process.env.DATABASE_URL);
const createdUserIds: string[] = [];
const html = new TextEncoder().encode("<!doctype html><h1>retained</h1>");

async function createUser(email?: string): Promise<string> {
  const id = `blocking-test-${randomUUID()}`;
  createdUserIds.push(id);
  await getDb()
    .insert(users)
    .values({
      id,
      name: "Blocking Test User",
      email: email ?? `${id}@example.test`,
      emailVerified: true,
      // The first-user trigger requires an explicit admin proposal; subsequent
      // inserts are deliberately rewritten to user and tests promote actors via makeAdmin().
      role: "admin",
    });
  return id;
}

async function makeAdmin(userId: string): Promise<void> {
  await getDb().update(users).set({ role: "admin" }).where(eq(users.id, userId));
}

describe.skipIf(!hasDb)("identity blocking (integration)", () => {
  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await getDb().delete(userBlocks).where(inArray(userBlocks.userId, createdUserIds));
      await getDb().delete(users).where(inArray(users.id, createdUserIds));
    }
    await closeDb();
  });

  it("revokes credentials, hides retained drafts, and restores content on unblock", async () => {
    const adminId = await createUser();
    const victimEmail = `Mixed-${randomUUID()}@Example.Test`;
    const victimId = await createUser(victimEmail);
    await makeAdmin(adminId);

    const { draft, version } = await createDraftWithFirstVersion({
      ownerId: victimId,
      title: "Retained while blocked",
      visibility: "public",
      bytes: html,
      source: "browser",
    });
    const createdToken = await createToken({
      userId: victimId,
      name: "revoked by moderation",
      scopes: ["drafts:read", "drafts:write"],
    });
    await getDb()
      .insert(sessions)
      .values({
        id: `session-${randomUUID()}`,
        token: `session-token-${randomUUID()}`,
        userId: victimId,
        expiresAt: new Date(Date.now() + 60_000),
        updatedAt: new Date(),
      });
    await getDb()
      .insert(accounts)
      .values({
        id: `account-${randomUUID()}`,
        userId: victimId,
        providerId: "github",
        accountId: `github-${randomUUID()}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    await blockUser({ userId: adminId }, victimId, "Repeated abusive uploads");
    await blockUser({ userId: adminId }, victimId, "This must not replace the reason");

    const [blockedUser] = await getDb()
      .select({ blockedAt: users.blockedAt })
      .from(users)
      .where(eq(users.id, victimId));
    expect(blockedUser?.blockedAt).toBeInstanceOf(Date);
    const [block] = await getDb().select().from(userBlocks).where(eq(userBlocks.userId, victimId));
    expect(block).toEqual(
      expect.objectContaining({
        normalizedEmail: victimEmail.trim().toLowerCase(),
        reason: "Repeated abusive uploads",
        blockedByUserId: adminId,
      }),
    );
    expect(
      await getDb()
        .select()
        .from(blockedOauthAccounts)
        .where(eq(blockedOauthAccounts.blockId, block!.id)),
    ).toHaveLength(1);
    expect(await getDb().select().from(sessions).where(eq(sessions.userId, victimId))).toHaveLength(
      0,
    );
    const [revoked] = await getDb()
      .select({ revokedAt: apiTokens.revokedAt })
      .from(apiTokens)
      .where(eq(apiTokens.id, createdToken.record.id));
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
    expect(await authenticateBearer(`Bearer ${createdToken.token}`)).toBeNull();

    expect(await getDraftBySlug(draft.slug)).toBeNull();
    const [retainedDraft] = await getDb()
      .select({ deletedAt: drafts.deletedAt })
      .from(drafts)
      .where(eq(drafts.id, draft.id));
    expect(retainedDraft?.deletedAt).toBeNull();
    expect(await getStorage().get(version.storageKey)).not.toBeNull();
    expect((await listDraftsForAdmin({ ownerId: victimId })).drafts[0]?.ownerBlocked).toBe(true);
    await expect(setDraftTitle(draft, "Blocked mutation", { userId: victimId })).rejects.toThrow(
      /not found/i,
    );
    await expect(setUserRole({ userId: adminId }, victimId, "admin")).rejects.toThrow(/blocked/i);
    await expect(setUserPlan({ userId: adminId }, victimId, "unlimited")).rejects.toThrow(
      /blocked/i,
    );
    await expect(deleteUserCompletely({ userId: adminId }, victimId)).rejects.toThrow(/unblocked/i);

    await expect(
      getDb()
        .insert(sessions)
        .values({
          id: `blocked-session-${randomUUID()}`,
          token: `blocked-token-${randomUUID()}`,
          userId: victimId,
          expiresAt: new Date(Date.now() + 60_000),
          updatedAt: new Date(),
        }),
    ).rejects.toThrow();
    await expect(
      getDb()
        .update(users)
        .set({ email: `changed-${randomUUID()}@example.test` })
        .where(eq(users.id, victimId)),
    ).rejects.toThrow();
    const generated = generateApiToken();
    await expect(
      getDb()
        .insert(apiTokens)
        .values({
          userId: victimId,
          name: "must fail",
          tokenPrefix: generated.tokenPrefix,
          tokenHash: generated.tokenHash,
          scopes: ["drafts:read"],
        }),
    ).rejects.toThrow();

    await getDb()
      .update(userBlocks)
      .set({ createdAt: sql`now() - interval '30 days'` })
      .where(eq(userBlocks.id, block!.id));
    await expect(purgeDeletedDrafts()).resolves.toEqual(
      expect.objectContaining({ purged: expect.any(Number), failed: expect.any(Number) }),
    );
    expect(await getStorage().get(version.storageKey)).not.toBeNull();
    expect(
      await getDb()
        .select()
        .from(drafts)
        .where(and(eq(drafts.id, draft.id), isNull(drafts.deletedAt))),
    ).toHaveLength(1);

    await unblockIdentityBlock({ userId: adminId }, block!.id);
    await unblockIdentityBlock({ userId: adminId }, block!.id);
    const [unblocked] = await getDb()
      .select({ blockedAt: users.blockedAt })
      .from(users)
      .where(eq(users.id, victimId));
    expect(unblocked?.blockedAt).toBeNull();
    expect(await getDraftBySlug(draft.slug)).toEqual(expect.objectContaining({ id: draft.id }));
    expect(await authenticateBearer(`Bearer ${createdToken.token}`)).toBeNull();
  });

  it("returns the generic signup response for a blocked email", async () => {
    const adminId = await createUser();
    const victimEmail = `blocked-signup-${randomUUID()}@example.test`;
    const victimId = await createUser(victimEmail);
    await makeAdmin(adminId);
    await blockUser({ userId: adminId }, victimId, "Signup oracle test");

    const response = await authPost(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: victimEmail.toUpperCase(),
          password: "test-password-123",
          name: "Blocked Signup",
        }),
      }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      message: "If this address can be registered, you can now sign in.",
    });
    expect(await getDb().select().from(users).where(eq(users.email, victimEmail))).toHaveLength(1);
  });

  it("delete-only permits re-registration; delete + block retains known identities", async () => {
    const adminId = await createUser();
    await makeAdmin(adminId);

    const deleteOnlyEmail = `delete-only-${randomUUID()}@example.test`;
    const deleteOnlyId = await createUser(deleteOnlyEmail);
    await deleteUserCompletely({ userId: adminId }, deleteOnlyId);
    const replacementId = await createUser(deleteOnlyEmail);
    expect(replacementId).toBeDefined();

    const blockedEmail = `delete-block-${randomUUID()}@example.test`;
    const blockedId = await createUser(blockedEmail);
    const oauthSubject = `github-${randomUUID()}`;
    await getDb()
      .insert(accounts)
      .values({
        id: `account-${randomUUID()}`,
        userId: blockedId,
        providerId: "github",
        accountId: oauthSubject,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    const { version } = await createDraftWithFirstVersion({
      ownerId: blockedId,
      title: "Deleted but denied",
      visibility: "public",
      bytes: html,
      source: "browser",
    });

    await deleteAndBlockUser({ userId: adminId }, blockedId, "Delete and retain identity");
    expect(await getDb().select().from(users).where(eq(users.id, blockedId))).toHaveLength(0);
    expect(await getStorage().get(version.storageKey)).toBeNull();
    const blockPage = await listIdentityBlocks({ search: blockedEmail });
    expect(blockPage.blocks[0]).toEqual(
      expect.objectContaining({
        userId: blockedId,
        accountRetained: false,
        oauthIdentityCount: 1,
      }),
    );
    const block = blockPage.blocks[0]!;

    await expect(
      getDb()
        .insert(users)
        .values({
          id: `blocked-email-${randomUUID()}`,
          name: "Blocked email",
          email: ` ${blockedEmail.toUpperCase()} `,
          emailVerified: true,
        }),
    ).rejects.toThrow();

    const changedEmailId = `blocked-oauth-user-${randomUUID()}`;
    createdUserIds.push(changedEmailId);
    await expect(
      getDb().transaction(async (tx) => {
        await tx.insert(users).values({
          id: changedEmailId,
          name: "Changed-email OAuth attempt",
          email: `changed-${randomUUID()}@example.test`,
          emailVerified: true,
        });
        await tx.insert(accounts).values({
          id: `blocked-oauth-${randomUUID()}`,
          userId: changedEmailId,
          providerId: "github",
          accountId: oauthSubject,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }),
    ).rejects.toThrow();
    expect(await getDb().select().from(users).where(eq(users.id, changedEmailId))).toHaveLength(0);
    expect(
      await getDb()
        .select()
        .from(accounts)
        .where(and(eq(accounts.providerId, "github"), eq(accounts.accountId, oauthSubject))),
    ).toHaveLength(0);

    await unblockIdentityBlock({ userId: adminId }, block.id);
    const unblockedReplacement = await createUser(blockedEmail);
    expect(unblockedReplacement).toBeDefined();
  });
});
