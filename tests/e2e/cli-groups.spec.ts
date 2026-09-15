import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { ApiDraft, ApiGroup } from "@/packages/cli/src/api";
import { publishingFixture } from "../browser/publishing";
import { signUp } from "./helpers";

function runCli(args: string[], token: string, configRoot: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("packages/cli/dist/index.js"), ...args], {
      shell: false,
      timeout: 30_000,
      env: {
        ...process.env,
        FORCE_COLOR: undefined,
        NO_COLOR: undefined,
        AGENTPLAN_TOKEN: token,
        AGENTPLAN_API_URL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
        XDG_CONFIG_HOME: configRoot,
        APPDATA: configRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("groups shipped CLI organizes nested groups, uploads, moves, and dissolves without changing links", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signUp(page.request);
  const base = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
  const created = await page.request.post("/api/v1/tokens", {
    headers: { origin: new URL(base).origin },
    data: { name: "Groups CLI" },
  });
  expect(created.status()).toBe(201);
  const token = (await created.json()).secret as string;
  const configRoot = await mkdtemp(path.join(process.cwd(), ".data/qa/cli-groups-"));
  async function command<T>(args: string[]): Promise<T> {
    const result = await runCli([...args, "--json"], token, configRoot);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    return JSON.parse(result.stdout) as T;
  }
  const createGroup = async (name: string, parent?: string) =>
    (
      await command<{ group: ApiGroup }>([
        "groups",
        "create",
        name,
        ...(parent ? ["--parent", parent] : []),
      ])
    ).group;
  try {
    const customer = await createGroup("Customer");
    const project = await createGroup("Relaunch", customer.id);
    const design = await createGroup("Design", project.id);
    const archive = await createGroup("Archive");
    const html = (
      await command<{ draft: ApiDraft }>([
        "upload",
        publishingFixture("plan.html"),
        "--group",
        design.id,
      ])
    ).draft;
    const bundle = (
      await command<{ draft: ApiDraft }>([
        "upload",
        publishingFixture("folder"),
        "--group",
        project.id,
      ])
    ).draft;
    expect(html.groupId).toBe(design.id);
    expect(bundle.groupId).toBe(project.id);

    const direct = await command<{ drafts: ApiDraft[] }>(["list", "--group", customer.id]);
    expect(direct.drafts).toHaveLength(0);
    const recursive = await command<{ drafts: ApiDraft[] }>([
      "list",
      "--group",
      customer.id,
      "--recursive",
    ]);
    expect(recursive.drafts.map((draft) => draft.id).sort()).toEqual([html.id, bundle.id].sort());
    const roots = await command<{ groups: ApiGroup[]; nextCursor: string | null }>([
      "groups",
      "list",
      "--limit",
      "1",
    ]);
    expect(roots.groups).toHaveLength(1);
    expect(roots.nextCursor).toBeTruthy();
    const next = await command<{ groups: ApiGroup[] }>([
      "groups",
      "list",
      "--cursor",
      roots.nextCursor!,
    ]);
    expect(next.groups).toHaveLength(1);
    expect(next.groups[0]!.id).not.toBe(roots.groups[0]!.id);
    const descendants = await command<{ groups: ApiGroup[] }>([
      "groups",
      "list",
      "--parent",
      customer.id,
      "--recursive",
      "--search",
      "Design",
    ]);
    expect(descendants.groups.map((group) => group.id)).toEqual([design.id]);
    expect(descendants.groups[0]!.path.map((part) => part.name)).toEqual([
      "Customer",
      "Relaunch",
      "Design",
    ]);

    const movedGroup = await command<{ group: ApiGroup }>([
      "groups",
      "move",
      design.id,
      "--parent",
      archive.id,
    ]);
    expect(movedGroup.group.parentId).toBe(archive.id);
    const stillDesign = await command<{ draft: ApiDraft }>(["get", html.id]);
    expect(stillDesign.draft).toMatchObject({
      groupId: design.id,
      url: html.url,
      version: html.version,
    });
    const movedFiles = await command<{ movedCount: number }>([
      "move",
      html.id,
      bundle.id,
      "--group",
      archive.id,
    ]);
    expect(movedFiles.movedCount).toBe(2);
    expect(
      (await command<{ movedCount: number }>(["move", html.id, "--group", archive.id])).movedCount,
    ).toBe(0);
    await command(["move", bundle.id, "--ungrouped"]);
    const ungrouped = await command<{ drafts: ApiDraft[] }>(["list", "--ungrouped"]);
    expect(ungrouped.drafts.map((draft) => draft.id)).toEqual([bundle.id]);

    await command(["groups", "move", design.id, "--parent", project.id]);
    await command(["move", html.id, "--group", project.id]);
    await command(["groups", "dissolve", project.id, "--yes"]);
    expect((await command<{ draft: ApiDraft }>(["get", html.id])).draft.groupId).toBe(customer.id);
    const lifted = await command<{ groups: ApiGroup[] }>([
      "groups",
      "list",
      "--parent",
      customer.id,
    ]);
    expect(lifted.groups.map((group) => group.id)).toEqual([design.id]);
    await command(["groups", "move", design.id, "--root"]);
    await command(["groups", "dissolve", customer.id, "--yes"]);
    for (const before of [html, bundle]) {
      const { draft } = await command<{ draft: ApiDraft }>(["get", before.id]);
      expect(draft).toMatchObject({ groupId: null, url: before.url, version: before.version });
    }

    for (const args of [
      ["groups", "dissolve", archive.id],
      ["groups", "move", archive.id, "--root", "--parent", design.id],
      ["groups", "move", archive.id, "--parent", archive.id],
      ["list", "--recursive"],
      ["list", "--group", design.id, "--ungrouped"],
      ["upload", publishingFixture("plan.html"), "--group", design.id, "--draft", html.id],
      ["upload", publishingFixture("plan.html"), "--group", "Design"],
      ["move", html.id, html.id, "--ungrouped"],
      ["groups", "create", "A", "extra"],
      ["groups", "unknown"],
    ]) {
      // An invalid credential proves usage checks happen before authenticated calls.
      const result = await runCli([...args, "--json"], "invalid-local-test-token", configRoot);
      expect(result.code, result.stderr).toBe(2);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error.code).toBe("INVALID_ARGUMENT");
    }
  } finally {
    await rm(configRoot, { recursive: true, force: true });
  }
});
