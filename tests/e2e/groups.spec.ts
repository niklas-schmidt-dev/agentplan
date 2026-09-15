import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { publishingFixture } from "../browser/publishing";
import { signUp, uploadDraft } from "./helpers";

const origin = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
async function createGroup(request: APIRequestContext, name: string, parentId?: string) {
  const response = await request.post("/api/v1/groups", {
    headers: { origin },
    data: { name, parentId },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).group as { id: string; name: string };
}
async function createFromDialog(page: Page, name: string) {
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Group name", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Create group", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  return page.url().split("/").at(-1)!;
}
async function chooseGroup(page: Page, name: string) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("searchbox", { name: "Find a group" }).fill(name);
  await dialog
    .getByRole("listitem")
    .filter({ has: page.getByText(name, { exact: true }) })
    .getByRole("button")
    .first()
    .click();
}

test("groups support nested creation, browser uploads, scoped search, moves, and dissolving without changing links", async ({
  page,
}) => {
  await signUp(page.request);
  await page.goto("/dashboard/groups");
  await page.getByRole("button", { name: "+ New group", exact: true }).first().click();
  const rootId = await createFromDialog(page, "Website project");
  await page.getByRole("button", { name: "+ New subgroup", exact: true }).click();
  const designId = await createFromDialog(page, "Design work");
  await expect(page.getByRole("navigation", { name: "Group path" })).toContainText(
    "Website project",
  );
  await page.locator('input[name="file"]').setInputFiles(publishingFixture("plan.html"));
  await page.locator('input[name="title"]').fill("Grouped browser plan");
  await page.getByRole("button", { name: "upload", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/drafts\/[^/]+$/);
  const draftId = page.url().split("/").at(-1)!;
  const immutableUrl = await page
    .getByRole("link", { name: "view ↗", exact: true })
    .getAttribute("href");
  expect(immutableUrl).toBeTruthy();
  const draftResponse = await page.request.get(`/api/v1/drafts/${draftId}`);
  const original = (await draftResponse.json()).draft;
  expect(original.groupId).toBe(designId);
  await expect(page.getByRole("navigation", { name: "Group path" })).toContainText("Design work");
  await page.goto(`/dashboard/groups/${rootId}`);
  await expect(page.getByRole("link", { name: "Grouped browser plan", exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("searchbox", { name: "Search by title" }).fill("Grouped browser plan");
  await expect(page.getByLabel("Include subgroups")).toBeChecked();
  await page.getByRole("button", { name: "filter", exact: true }).click();
  await expect(page.getByRole("link", { name: "Grouped browser plan", exact: true })).toBeVisible();
  await page.getByLabel("Include subgroups").uncheck();
  await page.getByRole("button", { name: "filter", exact: true }).click();
  await expect(page.getByRole("link", { name: "Grouped browser plan", exact: true })).toHaveCount(
    0,
  );
  await page.goBack();
  await expect(page.getByRole("link", { name: "Grouped browser plan", exact: true })).toBeVisible();
  await expect(page.getByLabel("Include subgroups")).toBeChecked();
  await page.screenshot({ path: ".data/qa/artifacts/groups-desktop.png", fullPage: true });

  await page.goto(`/dashboard/groups/${designId}`);
  await page.getByRole("button", { name: "Edit group", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Group name", { exact: true }).fill("Approved design");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Approved design", exact: true })).toBeVisible();
  const destination = await createGroup(page.request, "Client archive");
  await page.getByRole("button", { name: "Move group", exact: true }).click();
  await chooseGroup(page, "Client archive");
  await page.getByRole("button", { name: "Move group here", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Group path" })).toContainText(
    "Client archive",
  );
  await page.getByRole("button", { name: "Dissolve group", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("1 direct file");
  await page.getByRole("button", { name: "Dissolve and keep contents", exact: true }).click();
  await expect(page).toHaveURL(`/dashboard/groups/${destination.id}`);
  await expect(page.getByRole("link", { name: "Grouped browser plan", exact: true })).toBeVisible();
  const updated = (await (await page.request.get(`/api/v1/drafts/${draftId}`)).json()).draft;
  expect(updated.groupId).toBe(destination.id);
  expect(updated.slug).toBe(original.slug);
  expect(original.version).toBe(1);
  expect(updated.version).toBe(original.version);
  await page.goto(immutableUrl!);
  await expect(
    page
      .frameLocator("iframe")
      .getByRole("heading", { name: "Browser published plan", exact: true }),
  ).toBeVisible();
});

test("groups bulk move preserves selection on failure and the detail destination can be changed", async ({
  page,
}) => {
  await signUp(page.request);
  const first = await uploadDraft(page.request, "<!doctype html><title>First</title>", {
    title: "First grouped file",
  });
  const second = await uploadDraft(page.request, "<!doctype html><title>Second</title>", {
    title: "Second grouped file",
  });
  const group = await createGroup(page.request, "Shared research");
  await page.goto("/dashboard?groupId=none");
  await page.getByLabel("Select this page", { exact: true }).check();
  await expect(page.getByText("2 selected · up to 50", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Move to…", exact: true }).click();
  await chooseGroup(page, "Shared research");
  await page.route(
    "**/api/v1/drafts/move",
    (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "INVALID_REQUEST", message: "Please retry this move." },
        }),
      }),
    { times: 1 },
  );
  await page.getByRole("button", { name: "Move files here", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Move 2 files", exact: true }).getByRole("alert"),
  ).toHaveText("Please retry this move.");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(page.getByText("2 selected · up to 50", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Move to…", exact: true }).click();
  await chooseGroup(page, "Shared research");
  await page.getByRole("button", { name: "Move files here", exact: true }).click();
  await expect(page.getByRole("link", { name: "First grouped file", exact: true })).toHaveCount(0);
  await page.goto(`/dashboard/groups/${group.id}`);
  await expect(page.getByRole("link", { name: "First grouped file", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Second grouped file", exact: true })).toBeVisible();
  await page.goto(`/dashboard/drafts/${first.id}`);
  await page.getByRole("button", { name: "Move to…", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "All groups", exact: true }).click();
  await page.getByRole("button", { name: "Choose Ungrouped", exact: true }).click();
  await page.getByRole("button", { name: "Move files here", exact: true }).click();
  await expect(page.getByRole("link", { name: "Ungrouped", exact: true })).toBeVisible();
  const moved = (await (await page.request.get(`/api/v1/drafts/${first.id}`)).json()).draft;
  const retained = (await (await page.request.get(`/api/v1/drafts/${second.id}`)).json()).draft;
  expect(moved.groupId).toBeNull();
  expect(retained.groupId).toBe(group.id);
});

test("groups remain reachable through twelve levels on mobile and dialogs support Escape", async ({
  page,
}) => {
  await signUp(page.request);
  const groups: Array<{ id: string; name: string }> = [];
  for (let level = 1; level <= 12; level++)
    groups.push(await createGroup(page.request, `Level ${level}`, groups.at(-1)?.id));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/dashboard/groups/${groups[0]!.id}`);
  for (const group of groups.slice(1)) {
    await page
      .getByRole("region", { name: "Subgroups", exact: true })
      .getByRole("link")
      .filter({ hasText: group.name })
      .click();
    await expect(page.getByRole("heading", { name: group.name, exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.screenshot({ path: ".data/qa/artifacts/groups-mobile.png", fullPage: true });
  await page.getByRole("button", { name: /· change$/ }).click();
  const picker = page.getByRole("dialog", { name: "Upload destination", exact: true });
  await picker.getByRole("button", { name: "All groups", exact: true }).click();
  for (const group of groups) {
    await picker.getByRole("button", { name: `Browse ${group.name}`, exact: true }).click();
  }
  await picker.getByRole("button", { name: "Choose Level 12", exact: true }).click();
  await expect(picker.getByText(/^Selected:/)).toContainText("Level 12");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await picker.getByRole("button", { name: "Use this destination", exact: true }).click();
  await expect(picker).not.toBeVisible();
  await expect(page.getByRole("button", { name: /· change$/ })).toContainText("Level 12");
  await page.getByRole("button", { name: "Edit group", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Edit group", exact: true })).toBeFocused();
  await page.getByLabel("Show all parent groups", { exact: true }).click();
  await page
    .getByRole("navigation", { name: "Group path" })
    .getByRole("link", { name: "Level 1", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Level 1", exact: true })).toBeVisible();
});

test("groups upload picker creates a destination in a nested dialog without losing the selected file", async ({
  page,
}) => {
  await signUp(page.request);
  await page.goto("/dashboard");
  const file = page.locator('input[name="file"]');
  await file.setInputFiles(publishingFixture("plan.html"));
  await page.locator('input[name="title"]').fill("New project plan");
  await page.getByRole("button", { name: "Ungrouped · change", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Upload destination", exact: true });
  await picker.getByRole("button", { name: "+ New group", exact: true }).click();
  const create = page.getByRole("dialog", { name: "New group", exact: true });
  await create.getByLabel("Group name", { exact: true }).fill("Created while uploading");
  const createdResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/groups" &&
      response.request().method() === "POST" &&
      response.status() === 201,
  );
  await create.getByRole("button", { name: "Create group", exact: true }).click();
  const group = (await (await createdResponse).json()).group;
  await expect(create).not.toBeVisible();
  await expect(picker).toBeVisible();
  await expect(
    picker.getByText("Selected: Created while uploading", { exact: true }),
  ).toBeVisible();
  await picker.getByRole("button", { name: "Use this destination", exact: true }).click();
  await expect(picker).not.toBeVisible();
  expect(await file.evaluate((element: HTMLInputElement) => element.files?.[0]?.name)).toBe(
    "plan.html",
  );
  await expect(page.locator('input[name="title"]')).toHaveValue("New project plan");
  await page.getByRole("button", { name: "upload", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/drafts\/[^/]+$/);
  await expect(page.getByRole("navigation", { name: "Group path" })).toContainText(
    "Created while uploading",
  );
  const draft = (
    await (await page.request.get(`/api/v1/drafts/${page.url().split("/").at(-1)}`)).json()
  ).draft;
  expect(draft.groupId).toBe(group.id);
});

for (const visibility of ["public", "private", "password"] as const) {
  test(`groups visibility ${visibility} remains unchanged through group moves and dissolution`, async ({
    page,
    browser,
  }) => {
    await signUp(page.request);
    const parent = await createGroup(page.request, `Internal client ${visibility}`);
    const group = await createGroup(page.request, `Internal planning ${visibility}`, parent.id);
    const destination = await createGroup(page.request, `Internal archive ${visibility}`);
    const hiddenNames = [parent.name, group.name, destination.name];
    const heading = `Preserved ${visibility} document`;
    const html = `<!doctype html><html><body><h1>${heading}</h1></body></html>`;
    const password = "groups-viewer-password-123";
    const draft = await uploadDraft(page.request, html, {
      title: heading,
      visibility,
      ...(visibility === "password" ? { password } : {}),
    });
    const assigned = await page.request.post("/api/v1/drafts/move", {
      headers: { origin },
      data: { draftIds: [draft.id], groupId: group.id },
    });
    expect(assigned.status()).toBe(200);
    const versions = await page.request.get(`/api/v1/drafts/${draft.id}/versions`);
    expect(versions.status()).toBe(200);
    const version = (await versions.json()).versions[0] as { id: string; url: string };
    const viewUrls = [draft.url, version.url];
    const contentUrls = [
      new URL(`/p/${draft.slug}/content`, draft.url).href,
      new URL(`/p/${draft.slug}/content?version=${version.id}`, draft.url).href,
    ];
    const anonymous = await browser.newContext();
    const granted = visibility === "password" ? await browser.newContext() : null;
    const visitor = await anonymous.newPage();
    const unlocked = granted ? await granted.newPage() : null;

    async function verifyAccess(viewer: Page, access: "granted" | "locked" | "denied") {
      for (const url of viewUrls) {
        const response = await viewer.goto(url);
        expect(response?.status()).toBe(access === "denied" ? 404 : 200);
        const body = await response!.text();
        for (const name of hiddenNames) expect(body).not.toContain(name);
        if (access === "granted") {
          await expect(
            viewer.frameLocator("iframe").getByRole("heading", { name: heading, exact: true }),
          ).toBeVisible();
        } else {
          await expect(viewer.locator("iframe")).toHaveCount(0);
          if (access === "locked")
            await expect(
              viewer.getByRole("heading", { name: /password-protected/i }),
            ).toBeVisible();
        }
      }
      for (const url of contentUrls) {
        const response = await viewer.request.get(url);
        expect(response.status()).toBe(access === "granted" ? 200 : 404);
        const body = await response.text();
        for (const name of hiddenNames) expect(body).not.toContain(name);
        if (access === "granted") {
          expect(body).toBe(html);
          if (visibility !== "public")
            expect(response.headers()["cache-control"]).toBe("private, no-store");
        }
      }
    }

    try {
      if (unlocked) {
        await unlocked.goto(version.url);
        await unlocked.getByLabel("Password", { exact: true }).fill(password);
        await unlocked.getByRole("button", { name: "unlock", exact: true }).click();
        await expect(
          unlocked.frameLocator("iframe").getByRole("heading", { name: heading, exact: true }),
        ).toBeVisible();
      }
      for (const stage of ["grouped", "moved", "dissolved"] as const) {
        if (stage === "moved") {
          const response = await page.request.patch(`/api/v1/groups/${group.id}`, {
            headers: { origin },
            data: { parentId: destination.id },
          });
          expect(response.status()).toBe(200);
        } else if (stage === "dissolved") {
          const response = await page.request.delete(`/api/v1/groups/${group.id}`, {
            headers: { origin },
          });
          expect(response.status()).toBe(204);
        }
        const current = (await (await page.request.get(`/api/v1/drafts/${draft.id}`)).json()).draft;
        expect(current).toMatchObject({
          slug: draft.slug,
          url: draft.url,
          visibility,
          version: 1,
          groupId: stage === "dissolved" ? destination.id : group.id,
        });
        await verifyAccess(page, "granted");
        await verifyAccess(
          visitor,
          visibility === "public" ? "granted" : visibility === "password" ? "locked" : "denied",
        );
        if (unlocked) await verifyAccess(unlocked, "granted");
      }
    } finally {
      await anonymous.close();
      await granted?.close();
    }
  });
}
