import { expect, test } from "@playwright/test";
import { signUp, uploadDraft } from "./helpers";

test("saves an HTML version as PDF through the browser print dialog", async ({ page, browser }) => {
  await signUp(page.request);
  const draft = await uploadDraft(
    page.request,
    "<!doctype html><title>PDF plan</title><style>body{background:#111;color:#eee}</style><h1>Quarterly plan</h1>",
    { visibility: "private" },
  );
  // Headless Chromium cannot show the dialog; record the call instead.
  await page.context().addInitScript(() => {
    window.print = () => {
      const root = document.documentElement;
      root.dataset.printCalls = String(Number(root.dataset.printCalls ?? 0) + 1);
    };
  });

  await page.goto(`/dashboard/drafts/${draft.id}`);
  const opened = page.context().waitForEvent("page");
  await page.getByRole("link", { name: "save as pdf" }).click();
  const printView = await opened;

  await expect(printView.getByRole("heading", { name: "Quarterly plan" })).toBeVisible();
  await expect(printView.locator("html")).toHaveAttribute("data-print-calls", "1");
  const url = new URL(printView.url());
  expect(url.pathname).toBe(`/p/${draft.slug}/content`);
  expect(url.searchParams.get("print")).toBe("1");
  // Top-level, yet still inside the content sandbox: an opaque origin without app cookies.
  expect(await printView.evaluate(() => self.origin)).toBe("null");
  expect(
    await printView.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("print-color-adjust"),
    ),
  ).toBe("exact");
  await printView.close();

  // The viewer keeps receiving the original bytes.
  const viewerBytes = await page.request.get(`/p/${draft.slug}/content`);
  expect(await viewerBytes.text()).not.toContain("print()");

  // Same authorization as the viewer: a private draft stays hidden.
  const anonymous = await browser.newContext();
  expect((await anonymous.request.get(`${url.pathname}${url.search}`)).status()).toBe(404);
  await anonymous.close();
});
