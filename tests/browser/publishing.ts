import path from "node:path";
import { expect, type Page } from "@playwright/test";

export const publishingFixture = (file: string) => path.resolve("tests/fixtures/publishing", file);

/** Shared with staging: deliberately uses only the browser and no database access. */
export async function signInBrowser(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("email", { exact: true }).fill(email);
  await page.getByLabel("password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

export async function publishBrowser(
  page: Page,
  file: string,
  title: string,
  folder = false,
): Promise<{ id: string; url: string }> {
  await page.goto("/dashboard");
  const disclosure = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "+ new draft" }) });
  if ((await disclosure.getAttribute("open")) === null) await disclosure.locator("summary").click();
  if (folder) await page.getByRole("button", { name: "HTML plan folder", exact: true }).click();
  await page.locator(`input[name="${folder ? "bundleFiles" : "file"}"]`).setInputFiles(file);
  await page.locator('input[name="title"]').fill(title);
  await page.getByRole("radio", { name: "public", exact: true }).check();
  await page.getByRole("button", { name: "upload", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/drafts\/[^/]+$/);
  const href = await page.getByRole("link", { name: "open ↗", exact: true }).getAttribute("href");
  expect(href).toBeTruthy();
  return { id: page.url().split("/").at(-1)!, url: new URL(href!, page.url()).href };
}

export async function expectPlayableVideo(page: Page) {
  const video = page.locator("video");
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.duration))
    .toBeGreaterThan(1);
  await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    await element.play();
  });
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(0);
  await video.evaluate((element: HTMLVideoElement) => {
    element.pause();
    element.currentTime = 1;
  });
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => !element.seeking && element.currentTime),
    )
    .toBe(1);
}
