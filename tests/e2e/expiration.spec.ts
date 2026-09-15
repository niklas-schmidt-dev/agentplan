import { expect, test } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { drafts } from "@/db/schema";
import { purgeDeletedDrafts } from "@/lib/drafts/purge";
import { publishingFixture } from "../browser/publishing";
import { signUp } from "./helpers";

for (const scenario of [
  { kind: "HTML", file: "plan.html", expiry: "1h", seconds: 3600, visibility: "public" },
  {
    kind: "image",
    file: "folder/images/pixel.gif",
    expiry: "1d",
    seconds: 86400,
    visibility: "private",
  },
  { kind: "video", file: "clip.mp4", expiry: "30d", seconds: 2592000, visibility: "public" },
  { kind: "bundle", file: "folder", expiry: "custom", seconds: 120, visibility: "password" },
]) {
  test(`auto-expiry: ${scenario.kind} upload revokes every link before permanent cleanup`, async ({
    page,
    browser,
  }) => {
    await signUp(page.request);
    await page.goto("/dashboard");
    const disclosure = page
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: "+ new draft" }) });
    if ((await disclosure.getAttribute("open")) === null)
      await disclosure.locator("summary").click();
    const bundle = scenario.kind === "bundle";
    if (bundle) await page.getByRole("button", { name: "HTML plan folder", exact: true }).click();
    await page
      .locator(`input[name="${bundle ? "bundleFiles" : "file"}"]`)
      .setInputFiles(publishingFixture(scenario.file));
    await page.locator('input[name="title"]').fill(`Temporary ${scenario.kind}`);
    await page.getByRole("radio", { name: scenario.visibility, exact: true }).check();
    if (scenario.visibility === "password")
      await page.locator('input[name="password"]').fill("expiry-test-password");
    await page
      .getByRole("combobox", { name: "auto-expiry", exact: true })
      .selectOption(scenario.expiry);
    if (scenario.expiry === "custom") {
      await page.getByLabel("duration", { exact: true }).fill("2");
      await page.getByRole("combobox", { name: "unit", exact: true }).selectOption("m");
    }
    if (bundle) {
      await page.setViewportSize({ width: 375, height: 812 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: ".data/qa/artifacts/auto-expiry-mobile.png", fullPage: true });
    }
    const before = Date.now();
    await page.getByRole("button", { name: "upload", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard\/drafts\/[^/]+$/);
    await expect(page.getByText(/Auto-expiry:/)).toBeVisible();
    const id = page.url().split("/").at(-1)!;
    const detail = await page.request.get(`/api/v1/drafts/${id}`);
    expect(detail.status()).toBe(200);
    const { draft } = await detail.json();
    expect(Date.parse(draft.expiresAt)).toBeGreaterThanOrEqual(before + scenario.seconds * 1000);
    expect(Date.parse(draft.expiresAt)).toBeLessThanOrEqual(Date.now() + scenario.seconds * 1000);
    const versionLink = (await page
      .getByRole("link", { name: "view ↗", exact: true })
      .getAttribute("href"))!;
    const preview = bundle
      ? (await page.locator("iframe").getAttribute("src"))!
      : `${draft.url}/content`;
    expect((await page.request.get(preview)).status()).toBe(200);
    let grantedAsset: string | undefined;
    if (bundle) {
      // Exercise the shared viewer, which serves the granted bundle URL directly.
      await page.goto(draft.url);
      const frame = page.frameLocator("iframe");
      await expect(frame.getByAltText("Relative image")).toHaveJSProperty("naturalWidth", 1);
      grantedAsset = await frame
        .getByAltText("Relative image")
        .evaluate((image: HTMLImageElement) => image.src);
    }
    await getDb()
      .update(drafts)
      .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(drafts.id, id));
    const anonymous = await browser.newContext();
    try {
      for (const client of [page.request, anonymous.request]) {
        for (const url of [
          draft.url,
          new URL(versionLink, draft.url).href,
          `${draft.url}/content`,
          ...(grantedAsset ? [grantedAsset] : []),
        ]) {
          expect((await client.get(url)).status(), url).toBe(404);
          expect((await client.head(url)).status(), url).toBe(404);
        }
      }
      expect((await page.request.get(`/api/v1/drafts/${id}`)).status()).toBe(404);
      expect((await page.request.get(`/api/v1/drafts/${id}/versions`)).status()).toBe(404);
      const listed = await (await page.request.get("/api/v1/drafts")).json();
      expect(listed.drafts.some((item: { id: string }) => item.id === id)).toBe(false);
      await purgeDeletedDrafts();
      expect(await getDb().select().from(drafts).where(eq(drafts.id, id))).toHaveLength(0);
    } finally {
      await anonymous.close();
    }
  });
}
