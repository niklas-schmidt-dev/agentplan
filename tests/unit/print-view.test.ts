import { describe, expect, it, vi } from "vitest";

const stored = vi.hoisted(() => ({
  bytes: new TextEncoder().encode("<!doctype html><title>Plan</title><h1>Quarterly plan</h1>"),
}));

vi.mock("@/lib/storage", () => ({
  getStorage: () => ({
    head: async () => ({ size: stored.bytes.byteLength, contentType: "text/html", etag: null }),
    open: async () => ({
      size: stored.bytes.byteLength,
      contentType: "text/html",
      etag: null,
      contentRange: null,
      body: new Blob([stored.bytes]).stream(),
    }),
  }),
}));

import { draftPrintPath } from "@/lib/urls";
import { isPrintRequest, storedContentResponse } from "@/lib/http/content-response";

const file = {
  storageKey: "drafts/plan.html",
  contentType: "text/html; charset=utf-8",
  contentSha256: "a".repeat(64),
  sizeBytes: stored.bytes.byteLength,
  visibility: "private" as const,
  isHtml: true,
  isVideo: false,
};

describe("PDF print view", () => {
  it("serves unchanged bytes without the print flag", async () => {
    const response = await storedContentResponse(new Request("https://agentplan.test/c"), file);
    expect(await response.text()).toBe(new TextDecoder().decode(stored.bytes));
    expect(response.headers.get("content-length")).toBe(String(stored.bytes.byteLength));
    expect(response.headers.get("etag")).toBe(`"${file.contentSha256}"`);
  });

  it("appends a print trigger inside the unchanged sandbox", async () => {
    const response = await storedContentResponse(
      new Request("https://agentplan.test/c?print=1"),
      file,
      { print: true },
    );
    const body = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder().decode(body);
    expect(text.startsWith(new TextDecoder().decode(stored.bytes))).toBe(true);
    expect(text).toMatch(/print-color-adjust:exact/);
    expect(text).toMatch(/<script>addEventListener\("load".*print\(\).*<\/script>$/);
    expect(response.headers.get("content-length")).toBe(String(body.byteLength));
    expect(response.headers.get("etag")).toBe(`"${file.contentSha256}-print"`);
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-forms allow-modals allow-popups; frame-ancestors 'self'",
    );

    const head = await storedContentResponse(
      new Request("https://agentplan.test/c?print=1", { method: "HEAD" }),
      file,
      { print: true },
    );
    expect(head.headers.get("content-length")).toBe(String(body.byteLength));
  });

  it("never modifies media", async () => {
    const response = await storedContentResponse(
      new Request("https://agentplan.test/c?print=1"),
      { ...file, contentType: "text/html", isHtml: false },
      { print: true },
    );
    expect(await response.text()).toBe(new TextDecoder().decode(stored.bytes));
    expect(response.headers.get("etag")).toBe(`"${file.contentSha256}"`);
  });

  it("recognizes only the explicit flag and builds a version-pinned link", () => {
    expect(isPrintRequest(new Request("https://agentplan.test/c?print=1"))).toBe(true);
    expect(isPrintRequest(new Request("https://agentplan.test/c?print=true"))).toBe(false);
    expect(isPrintRequest(new Request("https://agentplan.test/c"))).toBe(false);
    expect(draftPrintPath("my plan", "0b2f1c1e-1111-4111-8111-111111111111")).toBe(
      "/p/my%20plan/content?version=0b2f1c1e-1111-4111-8111-111111111111&print=1",
    );
  });
});
