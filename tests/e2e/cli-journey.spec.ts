import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { publishingFixture } from "../browser/publishing";
import { signUp } from "./helpers";

function runCli(args: string[], token: string, configRoot: string, input?: string) {
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
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(input);
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

test("dashboard token drives the shipped CLI through publishing, versions, and revocation", async ({
  page,
  browser,
}) => {
  await signUp(page.request);
  const configRoot = await mkdtemp(path.join(process.cwd(), ".data/qa/agentplan-cli-e2e-"));
  const anonymous = await browser.newContext();
  try {
    await page.goto("/dashboard/settings/tokens");
    await page.getByLabel("token name").fill("E2E shipped CLI");
    await page.getByRole("button", { name: "create token", exact: true }).click();
    await expect(page.getByRole("button", { name: "copy token", exact: true })).toBeVisible();
    // Keep this synthetic token in memory; it never goes into argv or an attachment.
    const token = (await page
      .locator("code")
      .filter({ hasText: /^ap_live_[A-Za-z0-9_-]+$/ })
      .textContent())!.trim();
    await page.getByRole("button", { name: "I have copied the token" }).click();
    const uploaded = await runCli(
      ["upload", publishingFixture("plan.html"), "--public", "--json"],
      token,
      configRoot,
    );
    expect(uploaded.code, uploaded.stderr).toBe(0);
    const { draft } = JSON.parse(uploaded.stdout) as { draft: { id: string; url: string } };
    const viewer = await anonymous.newPage();
    await viewer.goto(draft.url);
    await expect(
      viewer.frameLocator("iframe").getByRole("heading", { name: "Browser published plan" }),
    ).toBeVisible();
    const updated = await runCli(
      ["upload", publishingFixture("revised.html"), "--draft", draft.id, "--json"],
      token,
      configRoot,
    );
    expect(updated.code, updated.stderr).toBe(0);
    expect(JSON.parse(updated.stdout).draft.id).toBe(draft.id);
    await viewer.reload();
    await expect(
      viewer.frameLocator("iframe").getByRole("heading", { name: "Revised browser plan" }),
    ).toBeVisible();
    const listed = await runCli(["list", "--json"], token, configRoot);
    expect(listed.code, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout).drafts).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: draft.id, version: 2 })]),
    );
    const inspected = await runCli(["get", draft.id, "--json"], token, configRoot);
    expect(inspected.code, inspected.stderr).toBe(0);
    expect(JSON.parse(inspected.stdout).draft.version).toBe(2);
    const history = await runCli(["versions", draft.id, "--json"], token, configRoot);
    expect(history.code, history.stderr).toBe(0);
    const firstVersion = JSON.parse(history.stdout).versions.find(
      (version: { version: number }) => version.version === 1,
    );
    const restored = await runCli(
      ["restore", draft.id, firstVersion.id, "--json"],
      token,
      configRoot,
    );
    expect(restored.code, restored.stderr).toBe(0);
    expect(JSON.parse(restored.stdout).draft.version).toBe(3);
    await viewer.reload();
    await expect(
      viewer.frameLocator("iframe").getByRole("heading", { name: "Browser published plan" }),
    ).toBeVisible();
    const protectedDraft = await runCli(
      ["update", draft.id, "--title", "CLI protected draft", "--password-stdin", "--json"],
      token,
      configRoot,
      "synthetic-cli-password\n",
    );
    expect(protectedDraft.code, protectedDraft.stderr).toBe(0);
    expect(JSON.parse(protectedDraft.stdout).draft).toMatchObject({
      title: "CLI protected draft",
      visibility: "password",
    });
    expect(JSON.parse(protectedDraft.stdout).draft.url).not.toBe(draft.url);
    expect(protectedDraft.stdout + protectedDraft.stderr).not.toContain("synthetic-cli-password");
    const removed = await runCli(["delete", draft.id, "--yes", "--json"], token, configRoot);
    expect(removed.code, removed.stderr).toBe(0);
    expect(JSON.parse(removed.stdout)).toEqual({ deleted: true, id: draft.id });
    const missing = await runCli(["get", draft.id, "--json"], token, configRoot);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stderr).error.status).toBe(404);
    const bundled = await runCli(
      ["upload", publishingFixture("folder"), "--public", "--json"],
      token,
      configRoot,
    );
    expect(bundled.code, bundled.stderr).toBe(0);
    await viewer.goto(JSON.parse(bundled.stdout).draft.url);
    await expect(viewer.frameLocator("iframe").getByAltText("Relative image")).toHaveJSProperty(
      "naturalWidth",
      1,
    );
    await page.reload();
    const row = page.locator("li").filter({ hasText: "E2E shipped CLI" });
    await row.getByRole("button", { name: "revoke", exact: true }).click();
    await row.getByRole("button", { name: "confirm revoke", exact: true }).click();
    await expect(row).toHaveCount(0);
    const revoked = await runCli(["list", "--json"], token, configRoot);
    expect(revoked.code).not.toBe(0);
    expect(revoked.stderr).toMatch(/A valid session or API token is required/);
    expect(revoked.stdout).toBe("");
  } finally {
    await anonymous.close();
    await rm(configRoot, { recursive: true, force: true });
  }
});

test("write-only tokens can log in and publish through the shipped CLI", async ({ page }) => {
  await signUp(page.request);
  const configRoot = await mkdtemp(path.join(process.cwd(), ".data/qa/agentplan-cli-write-only-"));
  const base = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
  try {
    const created = await page.request.post("/api/v1/tokens", {
      headers: { origin: new URL(base).origin },
      data: { name: "Write only CLI", scopes: ["drafts:write"] },
    });
    expect(created.status()).toBe(201);
    const token = (await created.json()).secret as string;
    const login = await runCli(["login"], token, configRoot);
    expect(login.code, login.stderr).toBe(0);
    const denied = await runCli(["list", "--json"], token, configRoot);
    expect(denied.code).toBe(1);
    expect(JSON.parse(denied.stderr).error.status).toBe(403);
    const uploaded = await runCli(
      ["upload", publishingFixture("plan.html"), "--private", "--json"],
      token,
      configRoot,
    );
    expect(uploaded.code, uploaded.stderr).toBe(0);
    const id = JSON.parse(uploaded.stdout).draft.id;
    const deleted = await runCli(["delete", id, "--yes", "--json"], token, configRoot);
    expect(deleted.code, deleted.stderr).toBe(0);
  } finally {
    await rm(configRoot, { recursive: true, force: true });
  }
});
