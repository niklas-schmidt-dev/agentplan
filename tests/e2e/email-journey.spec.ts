import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { count } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { signInBrowser } from "../browser/publishing";

async function mailLink(request: APIRequestContext, email: string, kind: string) {
  let link: string | undefined;
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `${process.env.QA_MAIL_URL}/messages?to=${encodeURIComponent(email)}`,
        );
        expect(response.ok()).toBe(true);
        const messages = (await response.json()) as Array<{ kind: string; url: string }>;
        link = messages.findLast((message) => message.kind === kind)?.url;
        return Boolean(link);
      },
      { message: `local inbox should receive ${kind}` },
    )
    .toBe(true);
  return link!;
}

test("browser registration verifies through the inbox and password recovery invalidates old sessions", async ({
  page,
  browser,
}) => {
  test.skip(!process.env.QA_MAIL_URL, "Run npm run qa:up to enable the local email inbox.");
  const [row] = await getDb().select({ value: count() }).from(users);
  const email =
    (row?.value ?? 0) === 0
      ? (process.env.ADMIN_BOOTSTRAP_EMAIL ?? "e2e-bootstrap@example.test")
      : `e2e-mail-${randomUUID()}@example.test`;
  await page.goto("/login");
  await page.getByRole("button", { name: "no account? sign up →" }).click();
  await page.getByLabel("email", { exact: true }).fill(email);
  await page.getByLabel("password", { exact: true }).fill("e2e-mail-password-123");
  await page.getByRole("button", { name: "create account", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("verification link has been sent");
  const verification = await mailLink(page.request, email, "verify_email");
  await page.goto(verification);
  await expect(page).toHaveURL(/\/dashboard$/);
  const recovery = await browser.newContext();
  try {
    const recoveryPage = await recovery.newPage();
    await recoveryPage.goto("/login");
    await recoveryPage.getByRole("link", { name: "forgot password?" }).click();
    await recoveryPage.getByLabel("email", { exact: true }).fill(email);
    await recoveryPage.getByRole("button", { name: "send reset link" }).click();
    await expect(recoveryPage.getByRole("status")).toContainText(
      "password-reset link has been sent",
    );
    const reset = await mailLink(recovery.request, email, "reset_password");
    await recoveryPage.goto(reset);
    await recoveryPage
      .getByLabel("new password", { exact: true })
      .fill("e2e-mail-replaced-password-456");
    await recoveryPage.getByRole("button", { name: "set new password" }).click();
    await expect(recoveryPage).toHaveURL(/\/login$/);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login(?:\?|$)/);
    const oldLogin = await recovery.request.post("/api/auth/sign-in/email", {
      data: { email, password: "e2e-mail-password-123" },
    });
    expect(oldLogin.ok()).toBe(false);
    await signInBrowser(recoveryPage, email, "e2e-mail-replaced-password-456");
    await recoveryPage.goto(reset);
    await expect(recoveryPage.locator("main").getByRole("alert")).toContainText(
      "invalid or has expired",
    );
  } finally {
    await recovery.close();
  }
});

for (const status of [429, 500, "network"] as const) {
  test(`password recovery reports ${status} and allows retry`, async ({ page }) => {
    await page.goto("/forgot-password");
    await page.getByLabel("email", { exact: true }).fill("recovery@example.test");
    await page.route(
      "**/api/auth/request-password-reset",
      async (route) => {
        if (status === "network") await route.abort("failed");
        else
          await route.fulfill({
            status,
            contentType: "application/json",
            body: JSON.stringify({ code: "FAILED", message: "Failure" }),
          });
      },
      { times: 1 },
    );
    await page.getByRole("button", { name: "send reset link" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "send reset link" })).toBeEnabled();
    await page.route("**/api/auth/request-password-reset", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: true }),
      }),
    );
    await page.getByRole("button", { name: "send reset link" }).click();
    await expect(page.getByRole("status")).toContainText("password-reset link has been sent");
  });
}
