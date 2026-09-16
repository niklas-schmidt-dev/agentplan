import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.STORAGE_DRIVER = "fs";
process.env.STORAGE_FS_ROOT = mkdtempSync(path.join(os.tmpdir(), "agentplan-group-uploads-"));
process.env.BETTER_AUTH_SECRET ??= "group-upload-test-secret-not-for-production";

import { POST as createDraftRoute } from "@/app/api/v1/drafts/route";
import { POST as addVersionRoute } from "@/app/api/v1/drafts/[id]/versions/route";
import { POST as createBundleRoute } from "@/app/api/v1/uploads/bundles/route";
import { POST as createIntentRoute } from "@/app/api/v1/uploads/intents/route";
import { closeDb, getDb } from "@/db/client";
import { auditEvents, drafts, draftVersions, groups, uploadIntents, users } from "@/db/schema";
import { getGroupForOwner } from "@/db/queries/groups";
import { deleteUserCompletely } from "@/lib/admin/service";
import {
  addVersionToDraft,
  createDraftWithFirstVersion,
  restoreVersion,
} from "@/lib/drafts/service";
import { GroupNotFoundError } from "@/lib/groups/errors";
import { createGroup, dissolveGroup, moveDraftsToGroup, updateGroup } from "@/lib/groups/service";
import { getStorage } from "@/lib/storage";
import { createToken } from "@/lib/tokens/service";
import {
  completeBundleUpload,
  createBundleUpload,
  getBundleForOwner,
  restoreBundleVersion,
} from "@/lib/uploads/bundles";
import {
  cancelUploadIntent,
  completeUploadIntent,
  createUploadIntent,
} from "@/lib/uploads/service";

const hasDb = Boolean(process.env.DATABASE_URL);
const html = new TextEncoder().encode('<!doctype html><h1>Grouped</h1><img src="hero.png">');

describe.skipIf(!hasDb)("group destinations across upload lifecycles", () => {
  const ownerId = `group-upload-${randomUUID()}`;
  const otherId = `group-upload-other-${randomUUID()}`;
  const cleanupOwnerIds = [ownerId, otherId];
  const actor = { userId: ownerId };
  let token: string;
  let png: Uint8Array;

  beforeAll(async () => {
    for (const id of [ownerId, otherId]) {
      await getDb()
        .insert(users)
        .values({
          id,
          name: "Group upload owner",
          email: `${id}@example.test`,
          emailVerified: true,
          role: "admin",
          plan: "pro",
        });
    }
    token = (await createToken({ userId: ownerId, name: "groups", scopes: ["drafts:write"] }))
      .token;
    png = new Uint8Array(
      await sharp({ create: { width: 8, height: 8, channels: 3, background: "#82ff77" } })
        .png()
        .toBuffer(),
    );
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await getDb().delete(users).where(inArray(users.id, cleanupOwnerIds));
    await closeDb();
  });

  function legacy(groupId?: string | null) {
    return createDraftWithFirstVersion({
      ownerId,
      title: "Grouped HTML",
      visibility: "private",
      bytes: html,
      source: "browser",
      groupId,
    });
  }

  async function single(
    target: Parameters<typeof createUploadIntent>[0]["target"],
    filename = "plan.html",
    contentType = "text/html",
    bytes: Uint8Array = html,
  ) {
    const created = await createUploadIntent({
      ownerId,
      source: "browser",
      filename,
      contentType,
      sizeBytes: bytes.byteLength,
      target,
      baseUrl: "http://localhost:3000",
    });
    await getStorage().put(created.intent.stagingKey!, bytes, contentType);
    return created;
  }

  async function bundle(target: Parameters<typeof createBundleUpload>[0]["target"]) {
    const created = await createBundleUpload({
      ownerId,
      source: "browser",
      entryPath: "index.html",
      files: [
        { path: "index.html", contentType: "text/html", sizeBytes: html.byteLength },
        { path: "hero.png", contentType: "image/png", sizeBytes: png.byteLength },
      ],
      target,
    });
    const loaded = await getBundleForOwner(ownerId, created.intent.id);
    await getStorage().putIfAbsent(created.intent.finalKey, html, "text/html");
    await getStorage().putIfAbsent(loaded!.files[0]!.finalKey, png, "image/png");
    return created;
  }

  function jsonRequest(route: string, body: unknown) {
    return new Request(`http://localhost:3000${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function multipartRequest(route: string, groupId?: string) {
    const form = new FormData();
    form.set("file", new File([html], "plan.html", { type: "text/html" }));
    if (groupId !== undefined) form.set("groupId", groupId);
    return new Request(`http://localhost:3000${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
  }

  it("associates HTML, image and video intent uploads with their chosen group", async () => {
    const group = await createGroup(actor, { name: "Media" });
    const samples = [
      { filename: "plan.html", type: "text/html", bytes: html, kind: "html" },
      { filename: "image.png", type: "image/png", bytes: png, kind: "image" },
      {
        filename: "clip.mp4",
        type: "video/mp4",
        bytes: new Uint8Array(readFileSync("tests/fixtures/publishing/clip.mp4")),
        kind: "video",
      },
    ];
    for (const sample of samples) {
      const created = await single(
        { type: "new", visibility: "private", groupId: group.id },
        sample.filename,
        sample.type,
        sample.bytes,
      );
      expect(created.intent.targetGroupId).toBe(group.id);
      const completed = await completeUploadIntent(created.intent.id, ownerId);
      expect(completed.draft).toMatchObject({ groupId: group.id, kind: sample.kind });
    }
  });

  it("associates bundles and legacy multipart uploads, and keeps omitted groups optional", async () => {
    const group = await createGroup(actor, { name: "Documents" });
    const created = await bundle({ type: "new", visibility: "private", groupId: group.id });
    expect((await completeBundleUpload(created.intent.id, ownerId)).draft.groupId).toBe(group.id);
    const response = await createDraftRoute(multipartRequest("/api/v1/drafts", group.id));
    expect(response.status).toBe(201);
    expect((await response.json()).draft.groupId).toBe(group.id);
    expect((await legacy()).draft.groupId).toBeNull();
    const ungrouped = await single({ type: "new", visibility: "private" });
    expect((await completeUploadIntent(ungrouped.intent.id, ownerId)).draft.groupId).toBeNull();
  });

  it("rejects nonexistent and foreign destinations before legacy storage writes", async () => {
    const foreign = await createGroup({ userId: otherId }, { name: "Private group" });
    const put = vi.spyOn(getStorage(), "put");
    for (const id of [randomUUID(), foreign.id]) {
      await expect(legacy(id)).rejects.toBeInstanceOf(GroupNotFoundError);
      await expect(
        single({ type: "new", visibility: "private", groupId: id }),
      ).rejects.toBeInstanceOf(GroupNotFoundError);
      await expect(
        bundle({ type: "new", visibility: "private", groupId: id }),
      ).rejects.toBeInstanceOf(GroupNotFoundError);
      const response = await createDraftRoute(multipartRequest("/api/v1/drafts", id));
      expect(response.status).toBe(404);
    }
    expect(put).not.toHaveBeenCalled();
    expect((await createDraftRoute(multipartRequest("/api/v1/drafts", ""))).status).toBe(400);
  });

  it("rejects group changes on all version upload endpoints", async () => {
    const group = await createGroup(actor, { name: "Version destination" });
    const initial = await legacy();
    const target = { type: "draft", draftId: initial.draft.id, groupId: group.id };
    const direct = await createIntentRoute(
      jsonRequest("/api/v1/uploads/intents", {
        filename: "plan.html",
        contentType: "text/html",
        sizeBytes: html.byteLength,
        target,
      }),
    );
    expect(direct.status).toBe(400);
    const bundled = await createBundleRoute(
      jsonRequest("/api/v1/uploads/bundles", {
        entryPath: "index.html",
        files: [{ path: "index.html", contentType: "text/html", sizeBytes: html.byteLength }],
        target,
      }),
    );
    expect(bundled.status).toBe(400);
    const multipart = await addVersionRoute(
      multipartRequest(`/api/v1/drafts/${initial.draft.id}/versions`, group.id),
      { params: Promise.resolve({ id: initial.draft.id }) },
    );
    expect(multipart.status).toBe(400);
  });

  it.each(["single", "bundle"] as const)(
    "validates and persists %s destination IDs through the API",
    async (mode) => {
      const group = await createGroup(actor, { name: `${mode} API group` });
      const foreign = await createGroup({ userId: otherId }, { name: "Foreign API group" });
      const route = mode === "single" ? createIntentRoute : createBundleRoute;
      const requestBody =
        mode === "single"
          ? { filename: "plan.html", contentType: "text/html", sizeBytes: html.byteLength }
          : {
              entryPath: "index.html",
              files: [{ path: "index.html", contentType: "text/html", sizeBytes: html.byteLength }],
            };
      for (const groupId of [group.id, null]) {
        const response = await route(
          jsonRequest(`/api/v1/uploads/${mode === "single" ? "intents" : "bundles"}`, {
            ...requestBody,
            target: { type: "new", visibility: "private", groupId },
          }),
        );
        expect(response.status).toBe(201);
        const created = await response.json();
        const [intent] = await getDb()
          .select()
          .from(uploadIntents)
          .where(eq(uploadIntents.id, created.intent.id));
        expect(intent!.targetGroupId).toBe(groupId);
        await cancelUploadIntent(ownerId, intent!.id);
      }
      for (const groupId of [foreign.id, randomUUID()]) {
        const response = await route(
          jsonRequest(`/api/v1/uploads/${mode === "single" ? "intents" : "bundles"}`, {
            ...requestBody,
            target: { type: "new", visibility: "private", groupId },
          }),
        );
        expect(response.status).toBe(404);
      }
    },
  );

  it("keeps the latest placement for legacy versions and restores from stale draft objects", async () => {
    const firstGroup = await createGroup(actor, { name: "Before" });
    const secondGroup = await createGroup(actor, { name: "After" });
    const initial = await legacy(firstGroup.id);
    await moveDraftsToGroup(actor, [initial.draft.id], secondGroup.id);
    const next = await addVersionToDraft({ draft: initial.draft, bytes: html, source: "browser" });
    expect(next.draft.groupId).toBe(secondGroup.id);
    await moveDraftsToGroup(actor, [initial.draft.id], null);
    const restored = await restoreVersion({
      draft: initial.draft,
      version: initial.version,
      source: "browser",
    });
    expect(restored.draft.groupId).toBeNull();
    expect(restored.draft.slug).toBe(initial.draft.slug);
  });

  it("keeps pending single and bundle destinations attached to a group when its subtree moves", async () => {
    const originalParent = await createGroup(actor, { name: "Original upload parent" });
    const destinationParent = await createGroup(actor, { name: "New upload parent" });
    const group = await createGroup(actor, {
      name: "Pending uploads",
      parentId: originalParent.id,
    });
    const direct = await single({ type: "new", visibility: "private", groupId: group.id });
    const bundled = await bundle({ type: "new", visibility: "private", groupId: group.id });

    await updateGroup(actor, group.id, { parentId: destinationParent.id });

    const pending = await getDb()
      .select({ groupId: uploadIntents.targetGroupId })
      .from(uploadIntents)
      .where(inArray(uploadIntents.id, [direct.intent.id, bundled.intent.id]));
    expect(pending).toEqual([{ groupId: group.id }, { groupId: group.id }]);
    expect((await completeUploadIntent(direct.intent.id, ownerId)).draft.groupId).toBe(group.id);
    expect((await completeBundleUpload(bundled.intent.id, ownerId)).draft.groupId).toBe(group.id);
    expect((await getGroupForOwner(group.id, ownerId))!.path.map((part) => part.id)).toEqual([
      destinationParent.id,
      group.id,
    ]);
  });

  it("serializes legacy creation before dissolution and rejects the removed target before later storage writes", async () => {
    const parent = await createGroup(actor, { name: "Legacy destination parent" });
    const child = await createGroup(actor, { name: "Legacy destination", parentId: parent.id });
    const storage = getStorage();
    const originalPut = storage.put.bind(storage);
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const put = vi.spyOn(storage, "put").mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return originalPut(...args);
    });
    const uploading = legacy(child.id);
    let dissolving: Promise<void> | undefined;
    try {
      await started;
      dissolving = dissolveGroup(actor, child.id);
      // Observe the actual competing lock request, rather than assuming a delay
      // means the dissolution has reached the serialized section.
      await vi.waitFor(
        async () => {
          const waiting = await getDb().execute<{ blocked: boolean }>(sql`
          select exists (
            select 1 from pg_locks where locktype = 'advisory' and not granted
              and classid = (hashtext('agentplan:user-storage')::bigint & 4294967295)::oid
              and objid = (hashtext(${ownerId})::bigint & 4294967295)::oid
          ) as blocked
        `);
          expect(waiting.rows[0]!.blocked).toBe(true);
        },
        { timeout: 2000, interval: 10 },
      );
      resume();
      const [created] = await Promise.all([uploading, dissolving]);
      const [persisted] = await getDb()
        .select()
        .from(drafts)
        .where(eq(drafts.id, created.draft.id));
      expect(persisted).toMatchObject({ groupId: parent.id, slug: created.draft.slug });
      const stored = await storage.open(created.version.storageKey);
      expect(new Uint8Array(await new Response(stored!.body).arrayBuffer())).toEqual(html);
      expect(await getGroupForOwner(child.id, ownerId)).toBeNull();

      put.mockClear();
      await expect(legacy(child.id)).rejects.toBeInstanceOf(GroupNotFoundError);
      expect(put).not.toHaveBeenCalled();
    } finally {
      resume();
      put.mockRestore();
      await Promise.allSettled([uploading, dissolving]);
    }
  });

  it("deletes nested groups through the account lifecycle while cleaning their stored file", async () => {
    const adminId = `group-deletion-admin-${randomUUID()}`;
    const victimId = `group-deletion-owner-${randomUUID()}`;
    cleanupOwnerIds.push(adminId, victimId);
    for (const id of [adminId, victimId]) {
      await getDb()
        .insert(users)
        .values({
          id,
          name: "Grouped account deletion fixture",
          email: `${id}@example.test`,
          emailVerified: true,
          role: "admin",
        });
    }
    await getDb().update(users).set({ role: "admin" }).where(eq(users.id, adminId));
    const victim = { userId: victimId };
    const root = await createGroup(victim, { name: "Account root" });
    const child = await createGroup(victim, { name: "Project", parentId: root.id });
    const nested = await createGroup(victim, { name: "Stored files", parentId: child.id });
    const uploaded = await createDraftWithFirstVersion({
      ownerId: victimId,
      title: "Grouped file to clean",
      visibility: "private",
      bytes: html,
      source: "browser",
      groupId: nested.id,
    });
    const stored = await getStorage().open(uploaded.version.storageKey);
    expect(new Uint8Array(await new Response(stored!.body).arrayBuffer())).toEqual(html);

    await deleteUserCompletely({ userId: adminId }, victimId);

    expect(await getDb().select().from(users).where(eq(users.id, victimId))).toEqual([]);
    expect(await getDb().select().from(groups).where(eq(groups.ownerId, victimId))).toEqual([]);
    expect(await getDb().select().from(drafts).where(eq(drafts.ownerId, victimId))).toEqual([]);
    expect(
      await getDb().select().from(draftVersions).where(eq(draftVersions.id, uploaded.version.id)),
    ).toEqual([]);
    expect(await getStorage().head(uploaded.version.storageKey)).toBeNull();
    const [deletion] = await getDb()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.userId, adminId), eq(auditEvents.eventType, "user.deleted")));
    expect(deletion!.metadata).toEqual({ storageCleanup: "complete", objectsDeleted: 1 });
  });

  it.each(["single", "bundle"] as const)(
    "preserves a move made during a pending %s version upload",
    async (mode) => {
      const group = await createGroup(actor, { name: `${mode} original` });
      const destination = await createGroup(actor, { name: `${mode} destination` });
      const start = mode === "single" ? single : bundle;
      const complete = mode === "single" ? completeUploadIntent : completeBundleUpload;
      const created = await start({ type: "new", visibility: "private", groupId: group.id });
      const first = await complete(created.intent.id, ownerId);
      const pending = await start({ type: "draft", draftId: first.draft.id });
      await moveDraftsToGroup(actor, [first.draft.id], destination.id);
      const next = await complete(pending.intent.id, ownerId);
      expect(next.draft.groupId).toBe(destination.id);
      expect(next.draft.slug).toBe(first.draft.slug);
      if (mode === "bundle") {
        await moveDraftsToGroup(actor, [first.draft.id], null);
        const restored = await restoreBundleVersion({
          ownerId,
          draftId: first.draft.id,
          sourceVersionId: first.version.id,
          source: "browser",
        });
        expect(restored.draft.groupId).toBeNull();
      }
    },
  );

  it.each(["single", "bundle"] as const)(
    "uses the latest destination after repeated dissolution during %s completion",
    async (mode) => {
      const root = await createGroup(actor, { name: `${mode} root` });
      const parent = await createGroup(actor, { name: "Parent", parentId: root.id });
      const child = await createGroup(actor, { name: "Child", parentId: parent.id });
      const start = mode === "single" ? single : bundle;
      const complete = mode === "single" ? completeUploadIntent : completeBundleUpload;
      const created = await start({ type: "new", visibility: "private", groupId: child.id });
      let entered!: () => void;
      let resume!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const storage = getStorage();
      const originalOpen = storage.open.bind(storage);
      const open = vi.spyOn(storage, "open").mockImplementationOnce(async (...args) => {
        entered();
        await gate;
        return originalOpen(...args);
      });
      const completion = complete(created.intent.id, ownerId);
      try {
        await started;
        for (const [removed, expected] of [
          [child.id, parent.id],
          [parent.id, root.id],
          [root.id, null],
        ]) {
          await dissolveGroup(actor, removed!);
          const [pending] = await getDb()
            .select()
            .from(uploadIntents)
            .where(eq(uploadIntents.id, created.intent.id));
          expect(pending!.targetGroupId).toBe(expected);
        }
        resume();
        const result = await completion;
        expect(result.draft.groupId).toBeNull();
        expect((await complete(created.intent.id, ownerId)).version.id).toBe(result.version.id);
        await expect(
          start({ type: "new", visibility: "private", groupId: child.id }),
        ).rejects.toBeInstanceOf(GroupNotFoundError);
      } finally {
        resume();
        open.mockRestore();
        await completion.catch(() => undefined);
      }
    },
  );
});
