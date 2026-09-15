import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/db/client";
import { drafts, groups, users } from "@/db/schema";
import {
  getGroupForOwner,
  getGroupPathsForOwner,
  listGroupsPageForOwner,
} from "@/db/queries/groups";
import { listDraftsPageForOwner } from "@/db/queries/drafts";
import { createGroup, updateGroup, dissolveGroup, moveDraftsToGroup } from "@/lib/groups/service";
import { GroupNotFoundError, InvalidGroupError } from "@/lib/groups/errors";
import { InvalidGroupCursorError } from "@/lib/api/group-cursor";
import { InvalidDraftCursorError } from "@/lib/api/draft-cursor";
import { createToken } from "@/lib/tokens/service";
import { GET as listRoute, POST as createRoute } from "@/app/api/v1/groups/route";
import {
  GET as getRoute,
  PATCH as patchRoute,
  DELETE as deleteRoute,
} from "@/app/api/v1/groups/[id]/route";
import { POST as moveRoute } from "@/app/api/v1/drafts/move/route";
import { GET as listDraftsRoute } from "@/app/api/v1/drafts/route";

const ownerIds: string[] = [];
async function owner() {
  const id = `groups-${randomUUID()}`;
  await getDb()
    .insert(users)
    .values({
      id,
      name: "Groups fixture",
      email: `${id}@example.test`,
      emailVerified: true,
      role: "admin",
    });
  ownerIds.push(id);
  return { userId: id };
}
async function draft(
  ownerId: string,
  groupId: string | null = null,
  extra: Partial<typeof drafts.$inferInsert> = {},
) {
  const [row] = await getDb()
    .insert(drafts)
    .values({ ownerId, groupId, slug: randomUUID(), title: "Group file", ...extra })
    .returning();
  return row!;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
function request(token: string, pathname: string, method = "GET", body?: unknown) {
  return new Request(`http://localhost:3000/api/v1/${pathname}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe.skipIf(!process.env.DATABASE_URL)("nested owner groups", () => {
  afterAll(async () => {
    if (ownerIds.length) await getDb().delete(users).where(inArray(users.id, ownerIds));
    await closeDb();
  });
  it("supports deep mixed-content trees, complete paths and live direct/subtree counts", async () => {
    const actor = await owner();
    const chain = [await createGroup(actor, { name: "Root" })];
    for (let i = 1; i < 12; i++)
      chain.push(await createGroup(actor, { name: `Level ${i}`, parentId: chain.at(-1)!.id }));
    const direct = await draft(actor.userId, chain[0]!.id);
    const nested = await draft(actor.userId, chain.at(-1)!.id);
    await draft(actor.userId, chain[1]!.id, { deletedAt: new Date() });
    await draft(actor.userId, chain[2]!.id, { expiresAt: new Date(Date.now() - 1000) });
    expect(await getGroupForOwner(chain[0]!.id, actor.userId)).toMatchObject({
      directDraftCount: 1,
      subtreeDraftCount: 2,
      childGroupCount: 1,
    });
    expect(
      (await getGroupForOwner(chain.at(-1)!.id, actor.userId))!.path.map((part) => part.id),
    ).toEqual(chain.map((group) => group.id));
    expect(
      (await listDraftsPageForOwner(actor.userId, { groupId: chain[0]!.id })).drafts.map(
        (row) => row.id,
      ),
    ).toEqual([direct.id]);
    expect(
      new Set(
        (
          await listDraftsPageForOwner(actor.userId, {
            groupId: chain[0]!.id,
            includeDescendants: true,
          })
        ).drafts.map((row) => row.id),
      ),
    ).toEqual(new Set([direct.id, nested.id]));
    expect(
      (
        await listGroupsPageForOwner(actor.userId, {
          parentId: chain[0]!.id,
          scope: "subtree",
          search: "Level 11",
        })
      ).groups.map((row) => row.id),
    ).toEqual([chain.at(-1)!.id]);
    expect((await listGroupsPageForOwner(actor.userId)).groups).toHaveLength(1);
    expect(
      (
        await getGroupPathsForOwner(
          actor.userId,
          chain.map((group) => group.id),
        )
      )[chain[5]!.id],
    ).toHaveLength(6);
  });
  it("rejects foreign and blocked access even when called directly", async () => {
    const actor = await owner();
    const other = await owner();
    const group = await createGroup(actor, { name: "Private" });
    const file = await draft(actor.userId);
    expect(await getGroupForOwner(group.id, other.userId)).toBeNull();
    expect(await getGroupPathsForOwner(other.userId, [group.id])).toEqual({});
    await expect(createGroup(other, { name: "Wrong", parentId: group.id })).rejects.toBeInstanceOf(
      GroupNotFoundError,
    );
    await expect(updateGroup(other, group.id, { name: "Wrong" })).rejects.toBeInstanceOf(
      GroupNotFoundError,
    );
    await expect(dissolveGroup(other, group.id)).rejects.toBeInstanceOf(GroupNotFoundError);
    await expect(moveDraftsToGroup(other, [file.id], null)).rejects.toBeInstanceOf(
      GroupNotFoundError,
    );
    await expect(
      listGroupsPageForOwner(other.userId, { parentId: group.id }),
    ).rejects.toBeInstanceOf(GroupNotFoundError);
    await expect(
      listDraftsPageForOwner(other.userId, { groupId: group.id }),
    ).rejects.toBeInstanceOf(GroupNotFoundError);
    await getDb().update(users).set({ blockedAt: new Date() }).where(eq(users.id, actor.userId));
    expect(await getGroupForOwner(group.id, actor.userId)).toBeNull();
    expect((await listGroupsPageForOwner(actor.userId)).groups).toEqual([]);
    await expect(createGroup(actor, { name: "Blocked" })).rejects.toBeInstanceOf(
      GroupNotFoundError,
    );
    await expect(updateGroup(actor, group.id, { name: "Blocked" })).rejects.toBeInstanceOf(
      GroupNotFoundError,
    );
    await expect(moveDraftsToGroup(actor, [file.id], null)).rejects.toBeInstanceOf(
      GroupNotFoundError,
    );
    await expect(dissolveGroup(actor, group.id)).rejects.toBeInstanceOf(GroupNotFoundError);
  });
  it("atomically rejects cycles and concurrent inverse moves", async () => {
    const actor = await owner();
    const a = await createGroup(actor, { name: "A" });
    const b = await createGroup(actor, { name: "B", parentId: a.id });
    await expect(
      updateGroup(actor, a.id, { parentId: b.id, name: "Wrong" }),
    ).rejects.toBeInstanceOf(InvalidGroupError);
    expect((await getGroupForOwner(a.id, actor.userId))!.name).toBe("A");
    await expect(updateGroup(actor, a.id, { parentId: a.id })).rejects.toBeInstanceOf(
      InvalidGroupError,
    );
    await updateGroup(actor, b.id, { parentId: null });
    const results = await Promise.allSettled([
      updateGroup(actor, a.id, { parentId: b.id }),
      updateGroup(actor, b.id, { parentId: a.id }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const roots = await listGroupsPageForOwner(actor.userId);
    expect(roots.groups).toHaveLength(1);
    expect((await listGroupsPageForOwner(actor.userId, { scope: "subtree" })).groups).toHaveLength(
      2,
    );
  });
  it("moves a subtree without changing draft identity, placement or timestamp", async () => {
    const actor = await owner();
    const root = await createGroup(actor, { name: "Root" });
    const other = await createGroup(actor, { name: "Other" });
    const child = await createGroup(actor, { name: "Child", parentId: root.id });
    const file = await draft(actor.userId, child.id);
    await updateGroup(actor, child.id, { parentId: other.id, name: "Renamed" });
    const [same] = await getDb().select().from(drafts).where(eq(drafts.id, file.id));
    expect(same).toEqual(file);
    expect((await getGroupForOwner(child.id, actor.userId))!.path.map((part) => part.name)).toEqual(
      ["Other", "Renamed"],
    );
    expect((await getGroupForOwner(root.id, actor.userId))!.subtreeDraftCount).toBe(0);
    expect((await getGroupForOwner(other.id, actor.userId))!.subtreeDraftCount).toBe(1);
  });
  it("treats uppercase parent IDs as the same group when creating and repeating a move", async () => {
    const actor = await owner();
    const root = await createGroup(actor, { name: "Case-insensitive root" });
    const child = await createGroup(actor, { name: "Child", parentId: root.id.toUpperCase() });
    expect(child.parentId).toBe(root.id);
    const [before] = await getDb()
      .update(groups)
      .set({ updatedAt: new Date("2020-01-01") })
      .where(eq(groups.id, child.id))
      .returning();
    expect(
      await updateGroup(actor, child.id.toUpperCase(), { parentId: root.id.toUpperCase() }),
    ).toEqual(before);
  });
  it("promotes direct children and files when dissolving nested and root groups", async () => {
    const actor = await owner();
    const a = await createGroup(actor, { name: "A" });
    const b = await createGroup(actor, { name: "B", parentId: a.id });
    const c = await createGroup(actor, { name: "C", parentId: b.id });
    const direct = await draft(actor.userId, b.id, { updatedAt: new Date("2020-01-01") });
    const nested = await draft(actor.userId, c.id);
    await dissolveGroup(actor, b.id);
    expect(await getGroupForOwner(b.id, actor.userId)).toBeNull();
    expect((await getGroupForOwner(c.id, actor.userId))!.parentId).toBe(a.id);
    const [moved] = await getDb().select().from(drafts).where(eq(drafts.id, direct.id));
    expect(moved).toMatchObject({
      groupId: a.id,
      slug: direct.slug,
      currentVersionId: direct.currentVersionId,
    });
    expect(moved!.updatedAt.getTime()).toBeGreaterThan(direct.updatedAt.getTime());
    await dissolveGroup(actor, a.id);
    expect((await getGroupForOwner(c.id, actor.userId))!.parentId).toBeNull();
    expect(
      (await listDraftsPageForOwner(actor.userId, { groupId: null })).drafts.map((row) => row.id),
    ).toEqual([direct.id]);
    expect((await listDraftsPageForOwner(actor.userId, { groupId: c.id })).drafts[0]!.id).toBe(
      nested.id,
    );
  });
  it("bulk moves are atomic, idempotent and reject expired/foreign/missing files", async () => {
    const actor = await owner();
    const other = await owner();
    const group = await createGroup(actor, { name: "Target" });
    const a = await draft(actor.userId);
    const b = await draft(actor.userId);
    const expired = await draft(actor.userId, null, { expiresAt: new Date(Date.now() - 1000) });
    const foreign = await draft(other.userId);
    for (const id of [foreign.id, expired.id, randomUUID()]) {
      await expect(moveDraftsToGroup(actor, [a.id, id], group.id)).rejects.toBeInstanceOf(
        GroupNotFoundError,
      );
      expect((await listDraftsPageForOwner(actor.userId, { groupId: null })).drafts).toHaveLength(
        2,
      );
    }
    expect(await moveDraftsToGroup(actor, [a.id, b.id], group.id)).toEqual({ movedCount: 2 });
    const before = await getDb().select().from(drafts).where(eq(drafts.id, a.id));
    expect(await moveDraftsToGroup(actor, [a.id, b.id], group.id)).toEqual({ movedCount: 0 });
    expect(await getDb().select().from(drafts).where(eq(drafts.id, a.id))).toEqual(before);
    expect(
      await moveDraftsToGroup(
        actor,
        [a.id.toUpperCase(), b.id.toUpperCase()],
        group.id.toUpperCase(),
      ),
    ).toEqual({ movedCount: 0 });
    await expect(moveDraftsToGroup(actor, [a.id, a.id.toUpperCase()], null)).rejects.toBeInstanceOf(
      InvalidGroupError,
    );
    expect(await getDb().select().from(drafts).where(eq(drafts.id, a.id))).toEqual(before);
    expect(await moveDraftsToGroup(actor, [a.id], null)).toEqual({ movedCount: 1 });
  });
  it("paginates tied timestamps and binds group/draft cursors to hierarchy filters", async () => {
    const actor = await owner();
    const root = await createGroup(actor, { name: "Root" });
    const rows = Array.from({ length: 57 }, () => ({
      ownerId: actor.userId,
      parentId: root.id,
      name: "Sibling",
      createdAt: sql`'2026-09-15T10:00:00.123456Z'::timestamptz`,
    }));
    await getDb().insert(groups).values(rows);
    const first = await listGroupsPageForOwner(actor.userId, { parentId: root.id, limit: 50 });
    const last = await listGroupsPageForOwner(actor.userId, {
      parentId: root.id,
      limit: 50,
      cursor: first.nextCursor!,
    });
    expect(first.groups).toHaveLength(50);
    expect(last.groups).toHaveLength(7);
    expect(new Set([...first.groups, ...last.groups].map((row) => row.id)).size).toBe(57);
    await expect(
      listGroupsPageForOwner(actor.userId, { scope: "subtree", cursor: first.nextCursor! }),
    ).rejects.toBeInstanceOf(InvalidGroupCursorError);
    await draft(actor.userId, root.id);
    await draft(actor.userId, root.id);
    const page = await listDraftsPageForOwner(actor.userId, { groupId: root.id, limit: 1 });
    await expect(
      listDraftsPageForOwner(actor.userId, { groupId: null, cursor: page.nextCursor! }),
    ).rejects.toBeInstanceOf(InvalidDraftCursorError);
    await expect(
      listDraftsPageForOwner(actor.userId, {
        groupId: root.id,
        includeDescendants: true,
        cursor: page.nextCursor!,
      }),
    ).rejects.toBeInstanceOf(InvalidDraftCursorError);
  });
  it("fails visibly for corrupt cyclic hierarchy and cleans account trees via cascade", async () => {
    const actor = await owner();
    const a = await createGroup(actor, { name: "A" });
    const b = await createGroup(actor, { name: "B", parentId: a.id });
    await draft(actor.userId, b.id);
    await getDb().update(groups).set({ parentId: b.id }).where(eq(groups.id, a.id));
    await expect(getGroupForOwner(a.id, actor.userId)).rejects.toBeInstanceOf(InvalidGroupError);
    await expect(
      listDraftsPageForOwner(actor.userId, { groupId: a.id, includeDescendants: true }),
    ).rejects.toBeInstanceOf(InvalidGroupError);
    const read = (
      await createToken({ userId: actor.userId, name: "cyclic reader", scopes: ["drafts:read"] })
    ).token;
    const response = await listDraftsRoute(
      request(read, `drafts?groupId=${a.id}&includeDescendants=true`),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_REQUEST");
    await getDb().update(groups).set({ parentId: null }).where(eq(groups.id, a.id));
    expect(
      (await listDraftsPageForOwner(actor.userId, { groupId: a.id, includeDescendants: true }))
        .drafts,
    ).toHaveLength(1);
    await getDb().delete(users).where(eq(users.id, actor.userId));
    expect(await getDb().select().from(groups).where(eq(groups.ownerId, actor.userId))).toEqual([]);
    expect(await getDb().select().from(drafts).where(eq(drafts.ownerId, actor.userId))).toEqual([]);
  });
  it("API enforces token scopes, owner isolation, valid filters and safe dissolve", async () => {
    const actor = await owner();
    const other = await owner();
    const read = (
      await createToken({ userId: actor.userId, name: "read", scopes: ["drafts:read"] })
    ).token;
    const write = (
      await createToken({
        userId: actor.userId,
        name: "both",
        scopes: ["drafts:read", "drafts:write"],
      })
    ).token;
    const foreign = await createGroup(other, { name: "Hidden" });
    expect((await createRoute(request(read, "groups", "POST", { name: "No" }))).status).toBe(403);
    const created = await createRoute(request(write, "groups", "POST", { name: "Parent" }));
    expect(created.status).toBe(201);
    const id = (await created.json()).group.id as string;
    expect((await listRoute(request(read, "groups"))).status).toBe(200);
    expect((await getRoute(request(read, `groups/${id}`), params(id))).status).toBe(200);
    expect((await getRoute(request(read, `groups/${foreign.id}`), params(foreign.id))).status).toBe(
      404,
    );
    expect(
      (await patchRoute(request(read, `groups/${id}`, "PATCH", { name: "No" }), params(id))).status,
    ).toBe(403);
    expect(
      (
        await patchRoute(
          request(write, `groups/${id}`, "PATCH", { parentId: id, name: "No" }),
          params(id),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await patchRoute(
          request(write, `groups/${id}`, "PATCH", { parentId: foreign.id }),
          params(id),
        )
      ).status,
    ).toBe(404);
    expect((await listRoute(request(read, `groups?parentId=${foreign.id}`))).status).toBe(404);
    expect((await listDraftsRoute(request(read, `drafts?groupId=${foreign.id}`))).status).toBe(404);
    expect((await listDraftsRoute(request(read, "drafts?includeDescendants=true"))).status).toBe(
      400,
    );
    expect((await listDraftsRoute(request(read, "drafts?groupId=none"))).status).toBe(200);
    const file = await draft(actor.userId);
    expect(
      (await moveRoute(request(read, "drafts/move", "POST", { draftIds: [file.id], groupId: id })))
        .status,
    ).toBe(403);
    expect(
      (await moveRoute(request(write, "drafts/move", "POST", { draftIds: [file.id], groupId: id })))
        .status,
    ).toBe(200);
    const repeatedMove = await moveRoute(
      request(write, "drafts/move", "POST", {
        draftIds: [file.id.toUpperCase()],
        groupId: id.toUpperCase(),
      }),
    );
    expect(repeatedMove.status).toBe(200);
    expect(await repeatedMove.json()).toEqual({ movedCount: 0 });
    expect(
      (
        await moveRoute(
          request(write, "drafts/move", "POST", {
            draftIds: [file.id, file.id.toUpperCase()],
            groupId: null,
          }),
        )
      ).status,
    ).toBe(400);
    expect((await deleteRoute(request(write, `groups/${id}`, "DELETE"), params(id))).status).toBe(
      204,
    );
    expect(
      await getDb()
        .select()
        .from(drafts)
        .where(and(eq(drafts.id, file.id), isNullGroup())),
    ).toHaveLength(1);
  });
});
function isNullGroup() {
  return sql`${drafts.groupId} is null`;
}
