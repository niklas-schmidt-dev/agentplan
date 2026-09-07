import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { signUp, uploadDraft } from "./helpers";

const origin = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

test("version links pin content, share independently, and restore without changing history", async ({
  page,
  browser,
}) => {
  await signUp(page.request);
  const draft = await uploadDraft(page.request, "<!doctype html><h1>Original plan</h1>", {
    visibility: "public",
  });
  const versionsUrl = `/api/v1/drafts/${draft.id}/versions`;
  const list = await page.request.get(versionsUrl);
  const first = (await list.json()).versions[0] as { id: string; url: string };
  expect(first.url).toBe(`${origin}/p/${draft.slug}/v/${first.id}`);
  const update = await page.request.post(versionsUrl, {
    headers: { origin },
    multipart: {
      file: {
        name: "new.html",
        mimeType: "text/html",
        buffer: Buffer.from("<!doctype html><h1>Updated plan</h1>"),
      },
    },
  });
  expect(update.status()).toBe(201);
  const second = (await update.json()).version;
  await page.goto(`/dashboard/drafts/${draft.id}`);
  const row = page
    .locator("li")
    .filter({ has: page.locator(`a[href="/p/${draft.slug}/v/${first.id}"]`) });
  await expect(row.getByRole("button", { name: "copy version link" })).toBeVisible();

  const context = await browser.newContext();
  const viewer = await context.newPage();
  await viewer.goto(first.url);
  await expect(
    viewer.frameLocator("iframe").getByRole("heading", { name: "Original plan" }),
  ).toBeVisible();
  await expect(viewer.getByRole("navigation", { name: "Version navigation" })).toContainText(
    "v1 · previous version",
  );
  await viewer.getByRole("link", { name: "view current version" }).click();
  await expect(
    viewer.frameLocator("iframe").getByRole("heading", { name: "Updated plan" }),
  ).toBeVisible();

  await row.getByRole("button", { name: "restore as current" }).click();
  await expect(page.getByText("v3 (current)", { exact: true })).toBeVisible();
  await viewer.reload();
  await expect(
    viewer.frameLocator("iframe").getByRole("heading", { name: "Original plan" }),
  ).toBeVisible();
  await viewer.goto(second.url);
  await expect(
    viewer.frameLocator("iframe").getByRole("heading", { name: "Updated plan" }),
  ).toBeVisible();
  expect(
    (await viewer.request.get(`/p/${draft.slug}/content?version=${randomUUID()}`)).status(),
  ).toBe(404);
  expect((await viewer.request.get(`/p/${draft.slug}/content?version=invalid`)).status()).toBe(404);
  const other = await uploadDraft(page.request, "<!doctype html><p>Other</p>", {
    visibility: "public",
  });
  expect((await viewer.request.get(`/p/${other.slug}/content?version=${first.id}`)).status()).toBe(
    404,
  );
  await context.close();
});

test("password unlock and wrong-password retry preserve the selected version", async ({
  page,
  browser,
}) => {
  await signUp(page.request);
  const draft = await uploadDraft(page.request, "<!doctype html><h1>Protected original</h1>", {
    visibility: "password",
    password: "version-password-123",
  });
  const listed = await page.request.get(`/api/v1/drafts/${draft.id}/versions`);
  const first = (await listed.json()).versions[0];
  const updated = await page.request.post(`/api/v1/drafts/${draft.id}/versions`, {
    headers: { origin },
    multipart: {
      file: {
        name: "new.html",
        mimeType: "text/html",
        buffer: Buffer.from("<!doctype html><h1>Protected latest</h1>"),
      },
    },
  });
  expect(updated.status()).toBe(201);
  const context = await browser.newContext();
  const viewer = await context.newPage();
  const contentUrl = `/p/${draft.slug}/content?version=${first.id}`;
  expect((await viewer.request.get(contentUrl)).status()).toBe(404);
  await viewer.goto(first.url);
  await viewer.getByLabel("Password", { exact: true }).fill("wrong-password-123");
  await viewer.getByRole("button", { name: "unlock" }).click();
  await expect(viewer.getByText("Incorrect password. Try again.")).toContainText(
    "Incorrect password",
  );
  await expect(viewer).toHaveURL(`${first.url}?error=1`);
  await viewer.getByLabel("Password", { exact: true }).fill("version-password-123");
  await viewer.getByRole("button", { name: "unlock" }).click();
  await expect(viewer).toHaveURL(first.url);
  await expect(
    viewer.frameLocator("iframe").getByRole("heading", { name: "Protected original" }),
  ).toBeVisible();
  expect((await viewer.request.get(contentUrl)).headers()["cache-control"]).toBe(
    "private, no-store",
  );
  await context.close();
});
