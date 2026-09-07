import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  expectPlayableVideo,
  publishBrowser,
  publishingFixture,
  signInBrowser,
} from "../browser/publishing";

test("real storage accepts browser HTML, images, folders, and playable video", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const email = process.env.QA_STAGING_EMAIL;
  const password = process.env.QA_STAGING_PASSWORD;
  if (!email || !password)
    throw new Error("QA_STAGING_EMAIL and QA_STAGING_PASSWORD are required.");
  const runTitle = `QA smoke ${randomUUID()}`;
  const created = new Set<string>();
  const anonymous = await browser.newContext();
  try {
    await signInBrowser(page, email, password);
    // Track successful completions even if a later navigation/assertion fails.
    page.on("response", async (response) => {
      if (
        !/\/api\/v1\/uploads\/(?:intents|bundles)\/[^/]+\/complete$/.test(response.url()) ||
        !response.ok()
      )
        return;
      try {
        const body = (await response.json()) as { draft?: { id?: string } };
        if (body.draft?.id) created.add(body.draft.id);
      } catch {
        /* The authenticated list in finally also finds completed smoke drafts. */
      }
    });
    const viewer = await anonymous.newPage();
    const html = await publishBrowser(page, publishingFixture("plan.html"), `${runTitle} HTML`);
    created.add(html.id);
    await viewer.goto(html.url);
    await expect(
      viewer.frameLocator("iframe").getByRole("heading", { name: "Browser published plan" }),
    ).toBeVisible();
    const image = await publishBrowser(
      page,
      publishingFixture("folder/images/pixel.gif"),
      `${runTitle} image`,
    );
    created.add(image.id);
    await viewer.goto(image.url);
    await expect(
      viewer.getByRole("img", { name: `${runTitle} image`, exact: true }),
    ).toHaveJSProperty("naturalWidth", 1);
    const folder = await publishBrowser(
      page,
      publishingFixture("folder"),
      `${runTitle} folder`,
      true,
    );
    created.add(folder.id);
    await viewer.goto(folder.url);
    await expect(viewer.frameLocator("iframe").getByAltText("Relative image")).toHaveJSProperty(
      "naturalWidth",
      1,
    );
    const video = await publishBrowser(page, publishingFixture("clip.mp4"), `${runTitle} video`);
    created.add(video.id);
    await viewer.goto(video.url);
    await expectPlayableVideo(viewer);
  } finally {
    await anonymous.close();
    const listed = await page.request.get("/api/v1/drafts");
    if (listed.ok()) {
      const body = (await listed.json()) as { drafts: Array<{ id: string; title: string }> };
      for (const draft of body.drafts) {
        if (draft.title.startsWith(`${runTitle} `)) created.add(draft.id);
      }
    }
    const origin = new URL(page.url()).origin;
    for (const id of created) {
      const deleted = await page.request.delete(`/api/v1/drafts/${id}`, { headers: { origin } });
      expect(deleted.status(), `cleanup of staging smoke draft ${id}`).toBe(204);
    }
  }
});
