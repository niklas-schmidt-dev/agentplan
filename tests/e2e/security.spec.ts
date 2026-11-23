import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { readProbeResults, signUp, uploadDraft } from "./helpers";

// Hostile document: probes every escape route and records the outcome in its
// own DOM, where the test (via automation privileges) can read it.
function hostileHtml(privateContentPath: string): string {
  return `<!doctype html><html><head><title>probing</title></head><body>
<script>
const results = {};
function record(name, fn) {
  try { results[name] = "VALUE:" + String(fn()); }
  catch (error) { results[name] = "BLOCKED:" + error.name; }
}
record("cookie", () => document.cookie);
record("parentDom", () => window.parent.document.title);
record("topNavigate", () => { window.top.location.href = "https://example.com/pwned"; return "navigated"; });
record("origin", () => window.origin);
Promise.allSettled([
  fetch("/api/v1/drafts").then(r => { results.apiFetch = "STATUS:" + r.status; }, e => { results.apiFetch = "BLOCKED:" + e.name; }),
  fetch(${JSON.stringify(privateContentPath)}).then(r => { results.privateFetch = "STATUS:" + r.status; }, e => { results.privateFetch = "BLOCKED:" + e.name; }),
]).then(() => {
  document.body.dataset.results = JSON.stringify(results);
  document.title = "probe-done";
});
</script>
</body></html>`;
}

test.describe("hostile HTML isolation", () => {
  test("security headers cover unauthenticated, API, and missing content responses", async ({
    page,
  }) => {
    const home = await page.request.get("/");
    expect(home.headers()["strict-transport-security"]).toContain("includeSubDomains");
    expect(home.headers()["x-frame-options"]).toBe("DENY");
    expect(home.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");

    const api = await page.request.get("/api/v1/drafts");
    expect(api.status()).toBe(401);
    expect(api.headers()["cache-control"]).toBe("private, no-store");
    expect(api.headers()["vary"]).toContain("Authorization");
    expect(api.headers()["vary"]).toContain("Cookie");

    const missingShell = await page.request.get("/p/does-not-exist");
    expect(missingShell.status()).toBe(404);
    const missingContent = await page.request.get("/p/does-not-exist/content");
    expect(missingContent.status()).toBe(404);
    expect(missingContent.headers()["cache-control"]).toBe("private, no-store");
    expect(missingContent.headers()["x-content-type-options"]).toBe("nosniff");
    expect(missingContent.headers()["strict-transport-security"]).toContain("includeSubDomains");

    const securityTxt = await page.request.get("/.well-known/security.txt");
    expect(securityTxt.status()).toBe(200);
    expect(await securityTxt.text()).toContain("Contact:");
    expect((await page.request.get("/security")).status()).toBe(200);
  });

  test("uploaded scripts run but cannot escape the sandbox", async ({ page }) => {
    await signUp(page.request);

    const privateDraft = await uploadDraft(page.request, "<!doctype html><h1>secret</h1>", {
      title: "Private secret",
      visibility: "private",
    });
    const hostile = await uploadDraft(
      page.request,
      hostileHtml(`/p/${privateDraft.slug}/content`),
      { title: "Hostile probe", visibility: "public" },
    );

    // View while the owner is signed in — this makes the cookie-theft and
    // private-fetch probes strictly harder to defeat than the anonymous case.
    await page.goto(`/p/${hostile.slug}`);
    const results = await readProbeResults(page);

    // Scripts executed (title flipped to probe-done) — but every escape failed.
    expect(results.cookie).not.toContain("better-auth");
    // In an opaque (sandboxed) origin, document.cookie throws or is empty.
    expect(results.cookie === "VALUE:" || results.cookie?.startsWith("BLOCKED:")).toBe(true);
    expect(results.parentDom).toMatch(/^BLOCKED:/);
    expect(results.topNavigate).toMatch(/^BLOCKED:/);
    expect(results.origin).toBe("VALUE:null");

    // Fetches from the opaque origin carry no credentials: they must either be
    // CORS-blocked or come back unauthorized/not-found — never authorized data.
    expect(results.apiFetch).not.toBe("STATUS:200");
    expect(results.privateFetch).not.toBe("STATUS:200");

    // The parent page was not navigated away.
    expect(page.url()).toContain(`/p/${hostile.slug}`);
  });

  test("viewer shell and content responses carry the isolation headers", async ({ page }) => {
    await signUp(page.request);
    const draft = await uploadDraft(page.request, "<!doctype html><p>hi</p>", {
      visibility: "public",
    });

    const shell = await page.request.get(`/p/${draft.slug}`);
    const shellCsp = shell.headers()["content-security-policy"] ?? "";
    expect(shellCsp).toContain("frame-src 'self'");
    expect(shellCsp).toContain("object-src 'none'");

    const content = await page.request.get(`/p/${draft.slug}/content`);
    const contentCsp = content.headers()["content-security-policy"] ?? "";
    expect(contentCsp).toContain("sandbox allow-scripts");
    expect(contentCsp).not.toContain("allow-same-origin");
    expect(content.headers()["x-content-type-options"]).toBe("nosniff");
    expect(content.headers()["referrer-policy"]).toBe("no-referrer");

    for (const url of [`/p/${draft.slug}`, `/dashboard/drafts/${draft.id}`]) {
      await page.goto(url);
      await expect(page.locator("iframe")).toHaveAttribute(
        "sandbox",
        "allow-scripts allow-forms allow-modals allow-popups",
      );
    }
  });

  test("private drafts are unreachable for anonymous visitors", async ({ page, browser }) => {
    await signUp(page.request);
    const draft = await uploadDraft(page.request, "<!doctype html><h1>top secret</h1>", {
      title: "Confidential",
      visibility: "private",
    });

    // A fresh context with no session cookie stands in for an anonymous visitor.
    const anon = await browser.newContext();
    const shell = await anon.request.get(`/p/${draft.slug}`);
    expect(shell.status()).toBe(404);
    const content = await anon.request.get(`/p/${draft.slug}/content`);
    expect(content.status()).toBe(404);
    await anon.close();
  });

  test("private and missing drafts share one 404 that offers sign-in back to the URL", async ({
    page,
    browser,
  }) => {
    const owner = await signUp(page.request);
    const draft = await uploadDraft(page.request, "<!doctype html><h1>owner only</h1>", {
      title: "Signed-out owner",
      visibility: "private",
    });

    const anon = await browser.newContext();
    const visitor = await anon.newPage();
    const missing = await visitor.goto("/p/does-not-exist-sign-in");
    expect(missing?.status()).toBe(404);
    const missingText = await visitor.locator("main").innerText();
    const missingTitle = await visitor.title();

    const versionPath = `/p/${draft.slug}/v/${randomUUID()}`;
    expect((await visitor.goto(versionPath))?.status()).toBe(404);
    await expect(visitor.getByRole("link", { name: "sign in", exact: true })).toHaveAttribute(
      "href",
      `/login?next=${encodeURIComponent(versionPath)}`,
    );

    const shell = await visitor.goto(`/p/${draft.slug}`);
    expect(shell?.status()).toBe(404);
    // The signed-out hint depends only on the visitor's session, so a private
    // draft must be indistinguishable from a URL that never existed.
    expect(await visitor.locator("main").innerText()).toBe(missingText);
    expect(await visitor.title()).toBe(missingTitle);
    await expect(visitor.getByRole("heading", { name: "404" })).toBeVisible();
    await expect(visitor.getByText("You’re not signed in — that may be why.")).toBeVisible();

    await visitor.getByRole("link", { name: "sign in", exact: true }).click();
    await expect(visitor).toHaveURL(`/login?next=${encodeURIComponent(`/p/${draft.slug}`)}`);
    await visitor.getByLabel("email", { exact: true }).fill(owner.email);
    await visitor.getByLabel("password", { exact: true }).fill("e2e-password-123");
    await visitor.getByRole("button", { name: "sign in", exact: true }).click();
    await expect(visitor).toHaveURL(`/p/${draft.slug}`);
    await expect(visitor.locator("iframe")).toHaveAttribute("title", draft.title);

    const signedInMissing = await visitor.goto("/p/does-not-exist-sign-in");
    expect(signedInMissing?.status()).toBe(404);
    await expect(visitor.getByText("You’re not signed in — that may be why.")).toHaveCount(0);
    await expect(visitor.getByRole("link", { name: "go to dashboard →" })).toBeVisible();

    await visitor.goto("/login?next=https://evil.example/");
    await expect(visitor).toHaveURL(/\/dashboard$/);
    await anon.close();
  });
});
