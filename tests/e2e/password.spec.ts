import { expect, test } from "@playwright/test";
import { signUp, uploadDraft } from "./helpers";

const SECRET_HTML = "<!doctype html><html><head><title>secret-doc</title></head><body><h1 id='secret'>classified</h1></body></html>";
const PASSWORD = "open-sesame-42";

test.describe("password-protected drafts (browser)", () => {
  test("prompts, rejects the wrong password, and unlocks with the right one", async ({
    page,
    browser,
  }) => {
    await signUp(page.request);
    const draft = await uploadDraft(page.request, SECRET_HTML, {
      title: "Confidential",
      visibility: "password",
      password: PASSWORD,
    });

    // Anonymous visitor in a fresh context: sees the gate, not the content.
    const anon = await browser.newContext();
    const visitor = await anon.newPage();
    await visitor.goto(`/p/${draft.slug}`);
    await expect(visitor.getByRole("heading", { name: /password-protected/i })).toBeVisible();
    // The document itself is not in the DOM (no iframe yet).
    expect(await visitor.locator("iframe").count()).toBe(0);

    // Wrong password → error, still gated.
    await visitor.getByLabel("Password").fill("not-the-password");
    await visitor.getByRole("button", { name: "unlock" }).click();
    await expect(visitor.getByText(/incorrect password/i)).toBeVisible();
    expect(await visitor.locator("iframe").count()).toBe(0);

    // Correct password → the sandboxed iframe appears and renders the content.
    await visitor.getByLabel("Password").fill(PASSWORD);
    await visitor.getByRole("button", { name: "unlock" }).click();
    const frame = visitor.frameLocator("iframe");
    await expect(frame.locator("#secret")).toHaveText("classified");

    // The grant persists on reload (cookie) — no re-prompt.
    await visitor.reload();
    await expect(visitor.frameLocator("iframe").locator("#secret")).toHaveText("classified");

    await anon.close();
  });

  test("the owner views a password draft without entering the password", async ({ page }) => {
    await signUp(page.request);
    const draft = await uploadDraft(page.request, SECRET_HTML, {
      title: "Owner view",
      visibility: "password",
      password: PASSWORD,
    });
    await page.goto(`/p/${draft.slug}`);
    // Owner session bypasses the gate entirely.
    await expect(page.frameLocator("iframe").locator("#secret")).toHaveText("classified");
  });
});
