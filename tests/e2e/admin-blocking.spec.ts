import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { signUp, uploadDraft } from "./helpers";

test("admin can block, restore, then delete while retaining the identity block", async ({
  page,
  browser,
}) => {
  const admin = await signUp(page.request);
  await getDb().update(users).set({ role: "admin" }).where(eq(users.email, admin.email));

  const victimContext = await browser.newContext();
  const victim = await signUp(victimContext.request);
  const draft = await uploadDraft(
    victimContext.request,
    "<!doctype html><h1>moderated upload</h1>",
    {
      title: "Blocking browser flow",
      visibility: "public",
    },
  );
  const anonymous = await browser.newContext();

  await page.goto("/dashboard/admin");
  const userRow = page.getByRole("listitem").filter({ hasText: victim.email });
  await userRow.getByRole("button", { name: "block", exact: true }).click();
  await userRow.getByPlaceholder("internal reason").fill("E2E moderation test");
  await userRow.getByRole("button", { name: "confirm block" }).click();
  await expect(userRow.getByText("blocked", { exact: true })).toBeVisible();
  expect((await anonymous.request.get(`/p/${draft.slug}`)).status()).toBe(404);
  expect((await anonymous.request.get(`/p/${draft.slug}/content`)).status()).toBe(404);

  await userRow.getByRole("button", { name: "unblock", exact: true }).click();
  await expect(userRow.getByText("blocked", { exact: true })).toHaveCount(0);
  expect((await anonymous.request.get(`/p/${draft.slug}`)).status()).toBe(200);
  expect((await anonymous.request.get(`/p/${draft.slug}/content`)).status()).toBe(200);

  await userRow.getByRole("button", { name: "delete + block", exact: true }).click();
  await userRow.getByPlaceholder("internal reason").fill("Delete and deny E2E test");
  await userRow.getByRole("button", { name: "delete + retain identities" }).click();
  await expect(page.getByText(victim.email, { exact: true })).toHaveCount(0);

  await page.goto("/dashboard/admin/blocks");
  const blockRow = page.getByRole("listitem").filter({ hasText: victim.email });
  await expect(blockRow.getByText("account deleted", { exact: true })).toBeVisible();
  await expect(blockRow.getByText("Delete and deny E2E test", { exact: true })).toBeVisible();

  await anonymous.close();
  await victimContext.close();
});
