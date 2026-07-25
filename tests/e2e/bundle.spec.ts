import { expect, test } from "@playwright/test";
import { signUp } from "./helpers";

test("uploads and renders a version-pinned HTML bundle", async ({ page }) => {
  await signUp(page.request);
  const origin = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
  const html = Buffer.from(
    '<!doctype html><title>bundle-ready</title><img id="hero" src="images/pixel.gif"><video src="video/demo.mp4"></video>',
  );
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
  const mp4 = Buffer.from([
    0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 105, 115,
    111, 50,
  ]);
  const local = new Map([
    ["nested/index.html", html],
    ["nested/images/pixel.gif", gif],
    ["nested/video/demo.mp4", mp4],
  ]);
  const createdResponse = await page.request.post("/api/v1/uploads/bundles", {
    headers: { origin },
    data: {
      entryPath: "nested/index.html",
      files: [
        { path: "nested/index.html", contentType: "text/html", sizeBytes: html.byteLength },
        { path: "nested/images/pixel.gif", contentType: "image/gif", sizeBytes: gif.byteLength },
        { path: "nested/video/demo.mp4", contentType: "video/mp4", sizeBytes: mp4.byteLength },
      ],
      target: { type: "new", title: "Bundle E2E", visibility: "public" },
    },
  });
  expect(createdResponse.status()).toBe(201);
  const created = (await createdResponse.json()) as {
    intent: { id: string };
    files: Array<{ id: string; path: string }>;
  };
  const targetResponse = await page.request.post(
    `/api/v1/uploads/bundles/${created.intent.id}/targets`,
    {
      headers: { origin },
      data: { fileIds: created.files.map((file) => file.id) },
    },
  );
  expect(targetResponse.ok()).toBe(true);
  const issued = (await targetResponse.json()) as {
    targets: Array<{
      fileId: string;
      uploaded: boolean;
      upload?: { method: string; url: string; headers: Record<string, string> };
    }>;
  };
  for (const target of issued.targets) {
    const descriptor = created.files.find((file) => file.id === target.fileId);
    expect(descriptor).toBeTruthy();
    expect(target.upload).toBeTruthy();
    const upload = await page.request.fetch(target.upload!.url, {
      method: target.upload!.method,
      headers: target.upload!.headers,
      data: local.get(descriptor!.path),
      maxRedirects: 0,
    });
    expect(upload.ok(), descriptor!.path).toBe(true);
  }

  const completedResponse = await page.request.post(
    `/api/v1/uploads/bundles/${created.intent.id}/complete`,
    { headers: { origin } },
  );
  expect(completedResponse.ok()).toBe(true);
  const completed = (await completedResponse.json()) as {
    draft: { slug: string };
    version: { id: string };
  };

  const compatibility = await page.request.get(`/p/${completed.draft.slug}/content`, {
    maxRedirects: 0,
  });
  expect(compatibility.status()).toBe(307);
  expect(compatibility.headers()["location"]).toContain(`/v/${completed.version.id}/`);

  await page.goto(`/p/${completed.draft.slug}`);
  await expect(page.locator("iframe")).toHaveAttribute("src", /\/v\//);
  await expect
    .poll(() => page.frames().some((candidate) => candidate.url().includes(`/v/`)))
    .toBe(true);
  const frame = page.frames().find((candidate) => candidate.url().includes(`/v/`));
  expect(frame).toBeTruthy();
  await expect(frame!.locator("#hero")).toHaveJSProperty("complete", true);
  await expect
    .poll(() =>
      frame!.locator("#hero").evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBe(1);

  const range = await page.request.get(
    `/p/${completed.draft.slug}/v/${completed.version.id}/nested/video/demo.mp4`,
    { headers: { Range: "bytes=4-7" } },
  );
  expect(range.status()).toBe(206);
  expect(await range.text()).toBe("ftyp");
});
