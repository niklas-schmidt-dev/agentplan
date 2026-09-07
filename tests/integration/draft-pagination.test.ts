import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/db/client";
import { drafts, users } from "@/db/schema";
import { listDraftsPageForOwner } from "@/db/queries/drafts";
import { InvalidDraftCursorError } from "@/lib/api/draft-cursor";

const ownerIds: string[] = [];
async function owner() {
  const id = `pagination-${randomUUID()}`;
  await getDb()
    .insert(users)
    .values({
      id,
      name: "Pagination fixture",
      email: `${id}@example.test`,
      emailVerified: true,
      role: "admin",
    });
  ownerIds.push(id);
  return id;
}

async function insertDrafts(ownerId: string, count: number) {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    ownerId,
    slug: `pagination-${randomUUID()}`,
    title: `Entry ${index}`,
    // Preserve sub-millisecond precision across timestamp ties and cursors.
    updatedAt: sql`'2026-09-07T10:00:00.123456Z'::timestamptz`,
  }));
  await getDb().insert(drafts).values(rows);
  return rows
    .map((row) => row.id)
    .sort()
    .reverse();
}

describe.skipIf(!process.env.DATABASE_URL)("owner draft cursor pagination", () => {
  afterAll(async () => {
    if (ownerIds.length) await getDb().delete(users).where(inArray(users.id, ownerIds));
    await closeDb();
  });

  it("discovers more than 200 drafts exactly once despite identical microsecond timestamps", async () => {
    const ownerId = await owner();
    const expected = await insertDrafts(ownerId, 207);
    const first = await listDraftsPageForOwner(ownerId);
    expect(first.drafts).toHaveLength(200);
    expect(first.previousCursor).toBeNull();
    expect(first.nextCursor).not.toBeNull();
    const last = await listDraftsPageForOwner(ownerId, { cursor: first.nextCursor! });
    expect(last.drafts).toHaveLength(7);
    expect(last.nextCursor).toBeNull();
    expect([...first.drafts, ...last.drafts].map((draft) => draft.id)).toEqual(expected);
    expect(new Set([...first.drafts, ...last.drafts].map((draft) => draft.id)).size).toBe(207);
    const previous = await listDraftsPageForOwner(ownerId, { cursor: last.previousCursor! });
    expect(previous.drafts.map((draft) => draft.id)).toEqual(first.drafts.map((draft) => draft.id));
    expect(previous.previousCursor).toBeNull();
  });

  it("returns adjacent pages in stable display order when paging backwards", async () => {
    const ownerId = await owner();
    const expected = await insertDrafts(ownerId, 13);
    const first = await listDraftsPageForOwner(ownerId, { limit: 5 });
    const second = await listDraftsPageForOwner(ownerId, { limit: 5, cursor: first.nextCursor! });
    const third = await listDraftsPageForOwner(ownerId, { limit: 5, cursor: second.nextCursor! });
    expect(third.drafts.map((draft) => draft.id)).toEqual(expected.slice(10));
    const back = await listDraftsPageForOwner(ownerId, { limit: 5, cursor: third.previousCursor! });
    expect(back.drafts.map((draft) => draft.id)).toEqual(expected.slice(5, 10));
    expect(back.previousCursor).not.toBeNull();
    const forward = await listDraftsPageForOwner(ownerId, { limit: 5, cursor: back.nextCursor! });
    expect(forward.drafts.map((draft) => draft.id)).toEqual(third.drafts.map((draft) => draft.id));
  });

  it("binds cursors to owner and filters and excludes deleted and blocked records", async () => {
    const ownerId = await owner();
    const otherOwner = await owner();
    const ids = await insertDrafts(ownerId, 8);
    await insertDrafts(otherOwner, 2);
    await getDb()
      .update(drafts)
      .set({ visibility: "public" })
      .where(inArray(drafts.id, ids.slice(0, 4)));
    const filters = { limit: 1, search: "Entry", visibility: "public" as const };
    const first = await listDraftsPageForOwner(ownerId, filters);
    expect(first.drafts).toHaveLength(1);
    const cursor = first.nextCursor!;
    await expect(listDraftsPageForOwner(otherOwner, { ...filters, cursor })).rejects.toBeInstanceOf(
      InvalidDraftCursorError,
    );
    await expect(
      listDraftsPageForOwner(ownerId, { ...filters, cursor, search: "different" }),
    ).rejects.toBeInstanceOf(InvalidDraftCursorError);
    await expect(
      listDraftsPageForOwner(ownerId, { ...filters, cursor, visibility: "private" }),
    ).rejects.toBeInstanceOf(InvalidDraftCursorError);
    await expect(
      listDraftsPageForOwner(ownerId, { ...filters, cursor, updatedWithinDays: 30 }),
    ).rejects.toBeInstanceOf(InvalidDraftCursorError);
    const second = await listDraftsPageForOwner(ownerId, { ...filters, cursor });
    expect(second.drafts[0]!.id).not.toBe(first.drafts[0]!.id);
    expect(second.drafts[0]).toMatchObject({ ownerId, visibility: "public" });
    await getDb()
      .update(drafts)
      .set({ deletedAt: new Date() })
      .where(eq(drafts.id, first.drafts[0]!.id));
    expect((await listDraftsPageForOwner(ownerId, filters)).drafts[0]!.id).not.toBe(
      first.drafts[0]!.id,
    );
    await getDb().update(users).set({ blockedAt: new Date() }).where(eq(users.id, ownerId));
    expect((await listDraftsPageForOwner(ownerId)).drafts).toEqual([]);
  });
});
