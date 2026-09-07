import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateArtifact } from "@/packages/cli/src/inspect";

const directories: string[] = [];
async function directory() {
  const value = await mkdtemp(path.join(tmpdir(), "agentplan-validate-"));
  directories.push(value);
  return value;
}
const html = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

describe("offline artifact validation", () => {
  it("accepts HTML above the retired size limit without network or authentication", async () => {
    const target = path.join(await directory(), "plan.html");
    await writeFile(target, html("a".repeat(2 * 1024 * 1024)));
    const network = vi.spyOn(globalThis, "fetch");
    expect(await validateArtifact(target)).toMatchObject({ valid: true, kind: "html" });
    expect(network).not.toHaveBeenCalled();
  });

  it("resolves nested references, encoded names, srcset and CSS against the selected entry", async () => {
    const root = await directory();
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "photo one.png"), "fixture");
    await writeFile(
      path.join(root, "nested/index.html"),
      html(
        '<img src="../photo%20one.png" srcset="../photo%20one.png 1x, https://example.com/image.png 2x"><style>body{background:url(../photo%20one.png)}</style>',
      ),
    );
    expect(await validateArtifact(root)).toMatchObject({
      valid: true,
      entryPath: "nested/index.html",
    });
  });

  it("reports missing bundle references and local filesystem paths", async () => {
    const root = await directory();
    await writeFile(
      path.join(root, "index.html"),
      html('<img src="missing.png"><img src="file:///Users/example/private.png">'),
    );
    const result = await validateArtifact(root);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "MISSING_REFERENCE",
      "LOCAL_FILESYSTEM_REFERENCE",
    ]);
  });

  it("keeps sensitive matches out of diagnostics", async () => {
    const root = await directory();
    await writeFile(
      path.join(root, "index.html"),
      html("ap_live_synthetic_fixture <div>__TITLE__</div>"),
    );
    const result = await validateArtifact(root);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "TOKEN_IN_HTML",
      "UNRESOLVED_PLACEHOLDER",
    ]);
    expect(JSON.stringify(result)).not.toContain("ap_live_synthetic_fixture");
  });

  it("rejects symlinks and unsupported assets", async () => {
    const root = await directory();
    await writeFile(path.join(root, "index.html"), html(""));
    await symlink(path.join(root, "index.html"), path.join(root, "link.html"));
    await expect(validateArtifact(root)).rejects.toThrow(/Symlinks/);
    await rm(path.join(root, "link.html"));
    await writeFile(path.join(root, "style.css"), "body {}");
    await expect(validateArtifact(root)).rejects.toThrow(/Unsupported bundle files/);
  });
});
