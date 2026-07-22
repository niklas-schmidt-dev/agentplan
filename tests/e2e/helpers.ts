import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";

/** Signs up via the test-only email endpoint (requires E2E_AUTH=1 on the server). */
export async function signUp(request: APIRequestContext): Promise<{ email: string }> {
  const email = `e2e-${randomUUID()}@example.test`;
  const response = await request.post("/api/auth/sign-up/email", {
    data: { email, password: "e2e-password-123", name: "E2E User" },
  });
  expect(response.ok(), "sign-up should succeed — is the server running with E2E_AUTH=1?").toBe(
    true,
  );
  return { email };
}

export async function uploadDraft(
  request: APIRequestContext,
  html: string,
  options: { title?: string; visibility?: "public" | "private" | "password"; password?: string } = {},
): Promise<{ id: string; slug: string; url: string; title: string }> {
  const response = await request.post("/api/v1/drafts", {
    multipart: {
      file: { name: "e2e.html", mimeType: "text/html", buffer: Buffer.from(html) },
      ...(options.title ? { title: options.title } : {}),
      ...(options.visibility ? { visibility: options.visibility } : {}),
      ...(options.password ? { password: options.password } : {}),
    },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as {
    draft: { id: string; slug: string; url: string; title: string };
  };
  return body.draft;
}

/** Waits for the hostile probe document inside the viewer iframe to finish. */
export async function readProbeResults(page: Page): Promise<Record<string, string>> {
  await expect
    .poll(() => page.frames().some((f) => f.url().includes("/content")), {
      message: "content iframe should attach",
    })
    .toBe(true);

  const frame = page.frames().find((f) => f.url().includes("/content"));
  if (!frame) throw new Error("content iframe not found");

  await frame.waitForFunction(() => document.title === "probe-done", undefined, {
    timeout: 15_000,
  });
  return frame.evaluate(
    () => JSON.parse(document.body.dataset.results ?? "{}") as Record<string, string>,
  );
}
