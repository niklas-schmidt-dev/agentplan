import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createGroupSchema,
  patchGroupSchema,
  moveDraftsSchema,
  listGroupsQuerySchema,
} from "@/lib/validation/groups";
import { listDraftsQuerySchema } from "@/lib/validation/api";
import { draftFilterKey } from "@/lib/api/draft-cursor";
import {
  groupFilterKey,
  encodeGroupCursor,
  decodeGroupCursor,
  InvalidGroupCursorError,
} from "@/lib/api/group-cursor";

describe("group input and cursor contracts", () => {
  it("validates trimmed names, optional descriptions and explicit root moves", () => {
    expect(createGroupSchema.parse({ name: "  Designs ", parentId: null })).toEqual({
      name: "Designs",
      parentId: null,
    });
    expect(createGroupSchema.safeParse({ name: " " }).success).toBe(false);
    expect(createGroupSchema.safeParse({ name: "x".repeat(121) }).success).toBe(false);
    expect(createGroupSchema.safeParse({ name: "a", description: "x".repeat(1001) }).success).toBe(
      false,
    );
    expect(createGroupSchema.safeParse({ name: "a", ownerId: "someone" }).success).toBe(false);
    expect(patchGroupSchema.safeParse({}).success).toBe(false);
    expect(patchGroupSchema.parse({ parentId: null, description: null })).toEqual({
      parentId: null,
      description: null,
    });
    expect(listGroupsQuerySchema.safeParse({ parentId: "" }).success).toBe(false);
  });
  it("rejects duplicate, empty and oversized bulk moves", () => {
    const id = randomUUID();
    for (const draftIds of [[], [id, id], Array.from({ length: 51 }, () => randomUUID())]) {
      expect(moveDraftsSchema.safeParse({ draftIds, groupId: null }).success).toBe(false);
    }
    expect(moveDraftsSchema.safeParse({ draftIds: [id], groupId: null }).success).toBe(true);
  });
  it("normalizes UUID case before comparing destinations and detecting duplicate files", () => {
    const id = "8f19f1bd-7461-4565-883a-4e35b60e145c";
    const uppercase = id.toUpperCase();
    expect(createGroupSchema.parse({ name: "Child", parentId: uppercase }).parentId).toBe(id);
    expect(patchGroupSchema.parse({ parentId: uppercase }).parentId).toBe(id);
    expect(listGroupsQuerySchema.parse({ parentId: uppercase }).parentId).toBe(id);
    expect(moveDraftsSchema.parse({ draftIds: [uppercase], groupId: uppercase })).toEqual({
      draftIds: [id],
      groupId: id,
    });
    expect(moveDraftsSchema.safeParse({ draftIds: [id, uppercase], groupId: null }).success).toBe(
      false,
    );
  });
  it("distinguishes all, ungrouped, direct and recursive draft scopes", () => {
    const id = randomUUID();
    expect(listDraftsQuerySchema.parse({ groupId: "none" }).groupId).toBeNull();
    expect(listDraftsQuerySchema.parse({}).groupId).toBeUndefined();
    expect(listDraftsQuerySchema.safeParse({ includeDescendants: "true" }).success).toBe(false);
    expect(
      listDraftsQuerySchema.safeParse({ groupId: "none", includeDescendants: "true" }).success,
    ).toBe(false);
    expect(
      listDraftsQuerySchema.parse({ groupId: id, includeDescendants: "false" }).includeDescendants,
    ).toBe(false);
    expect(
      listDraftsQuerySchema.safeParse({ groupId: id, includeDescendants: "yes" }).success,
    ).toBe(false);
    const fingerprints = [
      {},
      { groupId: null },
      { groupId: id },
      { groupId: id, includeDescendants: true },
    ].map((filters) => draftFilterKey("owner", filters));
    expect(new Set(fingerprints).size).toBe(4);
  });
  it("binds microsecond group cursors to owner, parent, search and scope", () => {
    const parentId = randomUUID();
    const filter = groupFilterKey("a", { parentId, scope: "subtree", search: "design" });
    const at = "2026-09-15T10:20:30.123456Z";
    const cursor = encodeGroupCursor(at, randomUUID(), filter);
    expect(decodeGroupCursor(cursor, filter).at).toBe(at);
    for (const alternate of [
      groupFilterKey("b", { parentId, scope: "subtree", search: "design" }),
      groupFilterKey("a", { parentId, scope: "children", search: "design" }),
      groupFilterKey("a", { scope: "subtree", search: "design" }),
      groupFilterKey("a", { parentId, scope: "subtree", search: "different" }),
    ]) {
      expect(() => decodeGroupCursor(cursor, alternate)).toThrow(InvalidGroupCursorError);
    }
    expect(() => decodeGroupCursor("broken", filter)).toThrow(InvalidGroupCursorError);
    expect(new InvalidGroupCursorError().name).toBe("InvalidGroupCursorError");
  });
});
