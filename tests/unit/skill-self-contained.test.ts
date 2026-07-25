import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const script = path.join(
  process.cwd(),
  "skills",
  "agentplan",
  "scripts",
  "check-self-contained.sh",
);
const temporaryDirectories: string[] = [];

function checkHtml(body: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "agentplan-skill-check-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "plan.html");
  writeFileSync(file, body);
  return spawnSync("bash", [script, file], { encoding: "utf8" });
}

function document(content: string, meta = '<meta charset="utf-8">') {
  return `<!doctype html><html><head>${meta}</head><body>${content}</body></html>`;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("AgentPlan self-contained HTML checker", () => {
  it("allows remote URLs containing local-directory words", () => {
    const result = checkHtml(document('<img src="https://example.com/home/overview.png">'));
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    '<img src="image.png">',
    '<video poster="poster.jpg"></video>',
    '<img srcset="https://example.com/a.png 1x, image@2x.png 2x">',
    "<style>body { background-image: url(bg.png); }</style>",
  ])("rejects a bare relative media reference: %s", (reference) => {
    const result = checkHtml(document(reference));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("upload the containing directory");
  });

  it.each([
    '<img src="file:///Users/example/private.png">',
    '<a href="/Users/example/private.html">local</a>',
    "<style>body { background: url(C:\\\\Users\\\\example\\\\private.png); }</style>",
  ])("rejects a local filesystem reference in an attribute or URL: %s", (reference) => {
    const result = checkHtml(document(reference));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("absolute local filesystem reference");
  });

  it("allows embedded data URLs in src and srcset", () => {
    const result = checkHtml(
      document(
        '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" srcset="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw== 1x">',
      ),
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it("requires a real charset attribute", () => {
    const invalid = checkHtml(document("", '<meta data-charset="utf-8">'));
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("missing a charset declaration");

    const valid = checkHtml(document("", '<meta charset = "utf-8">'));
    expect(valid.status, valid.stderr).toBe(0);
  });
});
