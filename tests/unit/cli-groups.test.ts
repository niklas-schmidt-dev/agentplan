import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPlanApi } from "@/packages/cli/src/api";
import { parseCommand } from "@/packages/cli/src/arguments";
import {
  draftGroupFilters,
  draftGroupTarget,
  groupListOptions,
  groupParentTarget,
  requireUuid,
} from "@/packages/cli/src/group-options";

const group = "11111111-1111-4111-8111-111111111111";
const draft = "22222222-2222-4222-8222-222222222222";

afterEach(() => vi.restoreAllMocks());

describe("CLI groups arguments", () => {
  it.each([
    ["groups", "create", "Design", "--parent", group, "--description", "Assets", "--json"],
    ["groups", "list", "--parent", group, "--recursive", "--search", "Design"],
    ["groups", "move", group, "--root"],
    ["groups", "dissolve", group, "--yes"],
    ["upload", "plan.html", "--group", group],
    ["list", "--group", group, "--recursive"],
    ["list", "--ungrouped"],
    ["move", draft, "--ungrouped"],
    ["move", draft, group, "--group", group],
  ])("accepts supported syntax: %j", (...args) => {
    expect(() => parseCommand(args)).not.toThrow();
  });

  it.each([
    ["groups"],
    ["groups", "unknown"],
    ["groups", "create"],
    ["groups", "create", "A", "B"],
    ["groups", "create", "A", "--root"],
    ["groups", "list", group],
    ["groups", "list", "--group", group],
    ["groups", "move", group, "--ungrouped"],
    ["groups", "dissolve", group, "--recursive"],
    ["list", "--parent", group],
    ["upload", "plan.html", "--ungrouped"],
    ["move"],
    ["list", "--group"],
    ["groups", "list", "--mystery"],
    ["groups", "list", "--limit", "1", "--limit", "2"],
    ["move", ...Array<string>(51).fill(draft), "--ungrouped"],
  ])("rejects invalid syntax with usage exit status: %j", (...args) => {
    expect(() => parseCommand(args)).toThrowError(expect.objectContaining({ exitCode: 2 }));
  });

  it("preserves existing lifecycle commands and their allowlists", () => {
    expect(parseCommand(["restore", draft, group, "--json"]).positionals).toHaveLength(3);
    expect(parseCommand(["update", draft, "--password-stdin"]).values["password-stdin"]).toBe(true);
    expect(() => parseCommand(["restore", draft, group, "--group", group])).toThrow();
  });

  it("distinguishes root group listing, subtree listing, and ungrouped drafts", () => {
    expect(groupListOptions({})).toMatchObject({ parentId: undefined, scope: "children" });
    expect(groupListOptions({ recursive: true })).toMatchObject({ scope: "subtree" });
    expect(groupListOptions({ parent: group, recursive: true })).toMatchObject({
      parentId: group,
      scope: "subtree",
    });
    expect(draftGroupFilters({})).toEqual({ groupId: undefined, includeDescendants: undefined });
    expect(draftGroupFilters({ ungrouped: true })).toMatchObject({ groupId: "none" });
    expect(draftGroupFilters({ group, recursive: true })).toEqual({
      groupId: group,
      includeDescendants: true,
    });
    expect(groupParentTarget({ root: true })).toBeNull();
    expect(draftGroupTarget({ ungrouped: true }, true)).toBeNull();
  });

  it("rejects ambiguous destinations and recursion without a group", () => {
    expect(() => draftGroupFilters({ group, ungrouped: true })).toThrow();
    expect(() => draftGroupFilters({ recursive: true })).toThrow();
    expect(() => draftGroupFilters({ ungrouped: true, recursive: true })).toThrow();
    expect(() => groupParentTarget({ parent: group, root: true })).toThrow();
    expect(() => groupParentTarget({})).toThrow();
    expect(() => draftGroupTarget({}, true)).toThrow();
    expect(() => groupListOptions({ parent: "" })).toThrow();
    expect(() => groupListOptions({ limit: "0" })).toThrow();
    expect(() => groupListOptions({ cursor: "" })).toThrow();
    expect(() => groupListOptions({ search: " " })).toThrow();
  });

  it.each([undefined, "", "design", `${group}/child`, "11111111-1111-1111-1111-111111111111"])(
    "requires UUID destinations: %s",
    (value) => {
      expect(() => requireUuid(value, "--group")).toThrow();
    },
  );
});

describe("CLI groups API contracts", () => {
  it("preserves hierarchy filters while paginating and serializes null destinations", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}));
    const api = new AgentPlanApi("https://agentplan.app", "test");
    await api.listGroups({
      parentId: group,
      scope: "subtree",
      search: "Design",
      cursor: "next",
      limit: 10,
    });
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      parentId: group,
      scope: "subtree",
      search: "Design",
      cursor: "next",
      limit: "10",
    });
    await api.listDrafts({ groupId: group, includeDescendants: true, cursor: "page-two" });
    expect(String(fetch.mock.calls[1]![0])).toContain(
      `groupId=${group}&includeDescendants=true&cursor=page-two`,
    );
    await api.moveDrafts([draft], null);
    expect(fetch.mock.calls[2]![0]).toBe("https://agentplan.app/api/v1/drafts/move");
    expect(JSON.parse(String(fetch.mock.calls[2]![1]?.body))).toEqual({
      draftIds: [draft],
      groupId: null,
    });
    await api.updateGroup(group, { parentId: null });
    expect(JSON.parse(String(fetch.mock.calls[3]![1]?.body))).toEqual({ parentId: null });
    await api.createGroup({ name: "Design", parentId: group });
    expect(JSON.parse(String(fetch.mock.calls[4]![1]?.body))).toEqual({
      name: "Design",
      parentId: group,
    });
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.dissolveGroup(group);
    expect(fetch.mock.calls[5]![1]?.method).toBe("DELETE");
  });

  it("sends the new group target through single-file and bundle intent creation", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}));
    const api = new AgentPlanApi("https://agentplan.app", "test");
    const target = { type: "new" as const, visibility: "private" as const, groupId: group };
    await api.createUploadIntent({
      filename: "plan.html",
      contentType: "text/html",
      sizeBytes: 20,
      target,
    });
    await api.createBundle({
      entryPath: "index.html",
      files: [{ path: "index.html", contentType: "text/html", sizeBytes: 20 }],
      target,
    });
    for (const [, init] of fetch.mock.calls)
      expect(JSON.parse(String(init?.body)).target).toEqual(target);
  });
});
