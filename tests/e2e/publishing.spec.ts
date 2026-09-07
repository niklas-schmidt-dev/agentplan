import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { uploadIntents, users } from "@/db/schema";
import { getUserStorageUsage } from "@/lib/limits/enforce";
import { limitsForPlan } from "@/lib/limits/plans";
import {
  expectPlayableVideo,
  publishBrowser,
  publishingFixture,
  signInBrowser,
} from "../browser/publishing";
import { signUp } from "./helpers";

test("browser sign-in, publishing, version restore, and privacy apply to anonymous viewers", async ({
  page,
  browser,
}) => {
  const { email } = await signUp(page.request);
  await page.context().clearCookies();
  await signInBrowser(page, email, "e2e-password-123");
  const draft = await publishBrowser(page, publishingFixture("plan.html"), "Browser journey");
  const firstUrl = await page
    .getByRole("link", { name: "view ↗", exact: true })
    .getAttribute("href");
  const anonymous = await browser.newContext();
  try {
    const viewer = await anonymous.newPage();
    await viewer.goto(draft.url);
    await expect(
      viewer.frameLocator("iframe").getByRole("heading", { name: "Browser published plan" }),
    ).toBeVisible();
    await page.getByLabel("upload new version").setInputFiles(publishingFixture("revised.html"));
    await page.getByRole("button", { name: "upload version", exact: true }).click();
    await expect(page.getByText("v2 (current)", { exact: true })).toBeVisible();
    await expect(
      page.frameLocator("iframe").getByRole("heading", { name: "Revised browser plan" }),
    ).toBeVisible();
    await viewer.reload();
    await expect(
      viewer.frameLocator("iframe").getByRole("heading", { name: "Revised browser plan" }),
    ).toBeVisible();
    const currentUrl = await page
      .locator("li")
      .filter({ hasText: "v2 (current)" })
      .getByRole("link", { name: "view ↗" })
      .getAttribute("href");
    await viewer.goto(new URL(firstUrl!, draft.url).href);
    await expect(
      viewer.frameLocator("iframe").getByRole("heading", { name: "Browser published plan" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "restore as current", exact: true }).click();
    await expect(page.getByText("v3 (current)", { exact: true })).toBeVisible();
    await expect(
      page.frameLocator("iframe").getByRole("heading", { name: "Browser published plan" }),
    ).toBeVisible();
    await viewer.goto(draft.url);
    await expect(
      viewer.frameLocator("iframe").getByRole("heading", { name: "Browser published plan" }),
    ).toBeVisible();
    await viewer.goto(new URL(currentUrl!, draft.url).href);
    await expect(
      viewer.frameLocator("iframe").getByRole("heading", { name: "Revised browser plan" }),
    ).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByLabel("Link version").selectOption("1");
    await expect(page.getByRole("link", { name: "open ↗", exact: true })).toHaveAttribute(
      "href",
      new URL(firstUrl!, draft.url).href,
    );
    await expect(
      page.getByText("Anyone with the link can open this draft.", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByLabel("Link version").selectOption("current");
    await page.getByRole("button", { name: "private", exact: true }).click();
    await expect.poll(async () => (await anonymous.request.get(draft.url)).status()).toBe(404);
    expect((await anonymous.request.get(new URL(firstUrl!, draft.url).href)).status()).toBe(404);
    await page.getByRole("button", { name: "public", exact: true }).click();
    const publicUrl = await page
      .getByRole("link", { name: "open ↗", exact: true })
      .getAttribute("href");
    await expect.poll(async () => (await anonymous.request.get(publicUrl!)).status()).toBe(200);
  } finally {
    await anonymous.close();
  }
});

test("folder picker preserves relative images, standalone images decode, and a real MP4 plays and seeks", async ({
  page,
  browser,
}) => {
  await signUp(page.request);
  const bundle = await publishBrowser(page, publishingFixture("folder"), "Browser folder", true);
  const anonymous = await browser.newContext();
  try {
    const viewer = await anonymous.newPage();
    await viewer.goto(bundle.url);
    await expect(
      viewer.frameLocator("iframe").getByRole("heading", { name: "Folder published plan" }),
    ).toBeVisible();
    await expect(viewer.frameLocator("iframe").getByAltText("Relative image")).toHaveJSProperty(
      "naturalWidth",
      1,
    );
    const image = await publishBrowser(
      page,
      publishingFixture("folder/images/pixel.gif"),
      "Standalone image",
    );
    await viewer.goto(image.url);
    await expect(
      viewer.getByRole("img", { name: "Standalone image", exact: true }),
    ).toHaveJSProperty("naturalWidth", 1);
    const video = await publishBrowser(page, publishingFixture("clip.mp4"), "Playable video");
    await viewer.goto(video.url);
    await expectPlayableVideo(viewer);
  } finally {
    await anonymous.close();
  }
});

test("an interrupted storage transfer releases its reservation and the browser can retry", async ({
  page,
}) => {
  const { email } = await signUp(page.request);
  const [user] = await getDb().select().from(users).where(eq(users.email, email));
  const before = await getUserStorageUsage(user!.id);
  await page.goto("/dashboard");
  await page.locator('input[name="file"]').setInputFiles(publishingFixture("plan.html"));
  await page.route(
    /\/api\/v1\/uploads\/intents\/[^/]+\/body(?:\?|$)/,
    (route) => route.abort("failed"),
    {
      times: 1,
    },
  );
  await page.getByRole("button", { name: "upload", exact: true }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveText(
    "The storage upload failed. Please try again.",
  );
  await expect(page.getByRole("button", { name: "upload", exact: true })).toBeEnabled();
  const intents = await getDb()
    .select()
    .from(uploadIntents)
    .where(eq(uploadIntents.ownerId, user!.id));
  expect(intents).toHaveLength(1);
  expect(intents[0]!.status).toBe("cancelled");
  expect(await getUserStorageUsage(user!.id)).toEqual(before);
  await page.getByRole("button", { name: "upload", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/drafts\/[^/]+$/);
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "Browser published plan" }),
  ).toBeVisible();
  expect((await getUserStorageUsage(user!.id)).reservedBytes).toBe(0);
});

test("a rejected file shows an error and selecting a valid file recovers", async ({ page }) => {
  const { email } = await signUp(page.request);
  const [user] = await getDb().select().from(users).where(eq(users.email, email));
  const before = await getUserStorageUsage(user!.id);
  await page.goto("/dashboard");
  await page.locator('input[name="file"]').setInputFiles({
    name: "invalid.png",
    mimeType: "image/png",
    buffer: Buffer.from("This is not a PNG image."),
  });
  await page.getByRole("button", { name: "upload", exact: true }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveText(
    "Stored content is not valid image/png.",
  );
  await expect(page.getByRole("button", { name: "upload", exact: true })).toBeEnabled();
  expect(await getUserStorageUsage(user!.id)).toEqual(before);
  await page.locator('input[name="file"]').setInputFiles(publishingFixture("plan.html"));
  await page.getByRole("button", { name: "upload", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/drafts\/[^/]+$/);
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "Browser published plan" }),
  ).toBeVisible();
});

test("quota rejection preserves saved content and cancelling a reservation allows retry", async ({
  page,
}) => {
  const { email } = await signUp(page.request);
  const [user] = await getDb().select().from(users).where(eq(users.email, email));
  const draft = await publishBrowser(page, publishingFixture("plan.html"), "Quota preservation");
  const before = await getUserStorageUsage(user!.id);
  const origin = new URL(page.url()).origin;
  const reservation = await page.request.post("/api/v1/uploads/intents", {
    headers: { origin },
    data: {
      filename: "pending.mp4",
      contentType: "video/mp4",
      sizeBytes: limitsForPlan("free").maxStorageBytes! - before.committedBytes,
      target: { type: "new", visibility: "private" },
    },
  });
  expect(reservation.status()).toBe(201);
  const { intent } = (await reservation.json()) as { intent: { id: string } };
  try {
    await page.getByLabel("upload new version").setInputFiles(publishingFixture("revised.html"));
    await page.getByRole("button", { name: "upload version", exact: true }).click();
    await expect(page.locator("form").getByRole("alert")).toContainText("Storage quota reached");
    await expect(page.getByText("v1 (current)", { exact: true })).toBeVisible();
    await expect(
      page.frameLocator("iframe").getByRole("heading", { name: "Browser published plan" }),
    ).toBeVisible();
    expect((await getUserStorageUsage(user!.id)).committedBytes).toBe(before.committedBytes);
    const cancelled = await page.request.delete(`/api/v1/uploads/intents/${intent.id}`, {
      headers: { origin },
    });
    expect(cancelled.ok()).toBe(true);
    await page.getByRole("button", { name: "upload version", exact: true }).click();
    await expect(page.getByText("v2 (current)", { exact: true })).toBeVisible();
    await page.goto(draft.url);
    await expect(
      page.frameLocator("iframe").getByRole("heading", { name: "Revised browser plan" }),
    ).toBeVisible();
    expect((await getUserStorageUsage(user!.id)).reservedBytes).toBe(0);
  } finally {
    await page.request.delete(`/api/v1/uploads/intents/${intent.id}`, { headers: { origin } });
  }
});

for (const bundle of [false, true]) {
  test(`lost ${bundle ? "bundle" : "file"} completion response recovers the original draft`, async ({
    page,
  }) => {
    const { email } = await signUp(page.request);
    const [owner] = await getDb().select().from(users).where(eq(users.email, email));
    await page.route(
      /\/api\/v1\/uploads\/(?:intents|bundles)\/[^/]+\/complete$/,
      async (route) => {
        const committed = await route.fetch();
        expect(committed.ok()).toBe(true);
        await route.abort("failed");
      },
      { times: 1 },
    );
    await publishBrowser(
      page,
      publishingFixture(bundle ? "folder" : "plan.html"),
      "Recovered completion",
      bundle,
    );
    const intents = await getDb()
      .select()
      .from(uploadIntents)
      .where(eq(uploadIntents.ownerId, owner!.id));
    expect(intents).toHaveLength(1);
    expect(intents[0]!.status).toBe("completed");
    await expect(page.getByText("v1 (current)", { exact: true })).toBeVisible();
  });
}

test("tokens can be created consecutively without redisplaying an acknowledged secret", async ({
  page,
}) => {
  await signUp(page.request);
  await page.goto("/dashboard/settings/tokens");
  for (const name of ["first-agent", "second-agent"]) {
    await page.getByLabel("token name").fill(name);
    await page.getByRole("button", { name: "create token", exact: true }).click();
    await expect(page.getByRole("button", { name: "copy token", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "I have copied the token" }).click();
    await page.getByLabel("token name").focus();
    await expect(page.getByRole("button", { name: "copy token", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("token name")).toBeVisible();
  }
});
