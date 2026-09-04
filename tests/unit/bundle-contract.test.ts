import { describe, expect, it } from "vitest";
import {
  normalizeBundlePath,
  selectBundleEntry,
  validateBundleManifest,
} from "@agentplan/upload-contract";

describe("HTML bundle contract", () => {
  it("normalizes safe POSIX paths and chooses a root entry", () => {
    expect(normalizeBundlePath("images/überblick.webp")).toBe("images/überblick.webp");
    expect(selectBundleEntry(["images/hero.png", "INDEX.Html"])).toBe("INDEX.Html");
    expect(selectBundleEntry(["nested/plan.htm", "images/hero.png"])).toBe("nested/plan.htm");
  });

  it.each([
    "/absolute.png",
    "../escape.png",
    "images\\escape.png",
    "images//empty.png",
    "images/./dot.png",
    "images/hero.png?download=1",
    "images/hero.png#fragment",
    "images/%2fescape.png",
    "images/\ud800.png",
    "__ap/private.png",
  ])("rejects unsafe path %s", (value) => {
    expect(() => normalizeBundlePath(value)).toThrow();
  });

  it("rejects case-folded collisions and additional HTML pages", () => {
    expect(() =>
      validateBundleManifest({
        entryPath: "index.html",
        files: [
          { path: "index.html", contentType: "text/html", sizeBytes: 10 },
          { path: "Hero.PNG", contentType: "image/png", sizeBytes: 10 },
          { path: "hero.png", contentType: "image/png", sizeBytes: 10 },
        ],
      }),
    ).toThrow(/Duplicate/);
    expect(() =>
      validateBundleManifest({
        entryPath: "index.html",
        files: [
          { path: "index.html", contentType: "text/html", sizeBytes: 10 },
          { path: "images/straße.png", contentType: "image/png", sizeBytes: 10 },
          { path: "images/STRASSE.png", contentType: "image/png", sizeBytes: 10 },
        ],
      }),
    ).toThrow(/Duplicate/);
    expect(() =>
      validateBundleManifest({
        entryPath: "index.html",
        files: [
          { path: "index.html", contentType: "text/html", sizeBytes: 10 },
          { path: "other.htm", contentType: "text/html", sizeBytes: 10 },
        ],
      }),
    ).toThrow(/Additional HTML/);
  });

  it("rejects empty files and excessive asset counts", () => {
    expect(() =>
      validateBundleManifest({
        entryPath: "index.html",
        files: [
          { path: "index.html", contentType: "text/html", sizeBytes: 10 },
          { path: "empty.png", contentType: "image/png", sizeBytes: 0 },
        ],
      }),
    ).toThrow(/must not be empty/);

    const files = [
      { path: "index.html", contentType: "text/html", sizeBytes: 1 },
      ...Array.from({ length: 51 }, (_, index) => ({
        path: `images/${index}.png`,
        contentType: "image/png",
        sizeBytes: 1,
      })),
    ];
    expect(() => validateBundleManifest({ entryPath: "index.html", files })).toThrow(
      /up to 50 assets/,
    );
  });

  it("accepts files and bundles above the former byte limits", () => {
    const manifest = validateBundleManifest({
      entryPath: "index.html",
      files: [
        { path: "index.html", contentType: "text/html", sizeBytes: 3 * 1024 ** 2 },
        { path: "hero.png", contentType: "image/png", sizeBytes: 11 * 1024 ** 2 },
        { path: "demo.mp4", contentType: "video/mp4", sizeBytes: 3 * 1024 ** 3 },
      ],
    });
    expect(manifest.totalBytes).toBe(14 * 1024 ** 2 + 3 * 1024 ** 3);
  });

  it("rejects an aggregate byte count outside safe integer precision", () => {
    expect(() =>
      validateBundleManifest({
        entryPath: "index.html",
        files: [
          { path: "index.html", contentType: "text/html", sizeBytes: Number.MAX_SAFE_INTEGER },
          { path: "hero.png", contentType: "image/png", sizeBytes: 1 },
        ],
      }),
    ).toThrow(/numeric range/);
  });
});
