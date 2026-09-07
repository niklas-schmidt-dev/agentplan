import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { publishingFixture } from "../browser/publishing";
import { signUp } from "./helpers";

function runCli(args: string[], token: string, configRoot: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("packages/cli/dist/index.js"), ...args], {
      shell: false,
      timeout: 30_000,
      env: {
        ...process.env,
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

test("dashboard token drives the shipped CLI through publishing, versions, and revocation", async ({
  page,
  browser,
}) => {
  await signUp(page.request);
  const configRoot = await mkdtemp(path.join(os.tmpdir(), "agentplan-cli-e2e-"));
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
