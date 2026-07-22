import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Static guardrails: the sandbox attributes are load-bearing security controls,
// so assert on the source directly. If these strings ever change, the reviewer
// is forced to confront the security implication.

const root = process.cwd();

// Strip comments before asserting: the source deliberately *names* the forbidden
// tokens in warning comments, so we must inspect only executable code.
function readCode(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("iframe sandbox is never weakened", () => {
  const viewerFiles = [
    "app/p/[slug]/page.tsx",
    "app/dashboard/drafts/[id]/page.tsx",
  ];

  for (const file of viewerFiles) {
    describe(file, () => {
      const source = readCode(file);

      it("uses the exact approved sandbox allowlist", () => {
        expect(source).toContain(
          'sandbox="allow-scripts allow-forms allow-modals allow-popups"',
        );
      });

      it("never grants same-origin or top-navigation", () => {
        expect(source).not.toContain("allow-same-origin");
        expect(source).not.toContain("allow-top-navigation");
      });
    });
  }
});

describe("content route ships hardened headers", () => {
  const source = readCode("app/p/[slug]/content/route.ts");

  it("sets a CSP sandbox even on direct navigation", () => {
    expect(source).toContain("sandbox allow-scripts allow-forms allow-modals allow-popups");
    expect(source).not.toContain("allow-same-origin");
  });

  it("sends nosniff, no-referrer, and visibility-aware caching", () => {
    expect(source).toContain('"X-Content-Type-Options": "nosniff"');
    expect(source).toContain('"Referrer-Policy": "no-referrer"');
    expect(source).toContain("private, no-store");
  });
});
