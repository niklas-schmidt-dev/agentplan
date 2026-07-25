import { describe, expect, it } from "vitest";
import {
  MAX_BUNDLE_BYTES,
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

  it("enforces per-file, file-count, and aggregate limits", () => {
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

    expect(() =>
      validateBundleManifest({
        entryPath: "index.html",
        files: [
          { path: "index.html", contentType: "text/html", sizeBytes: 1 },
          {
            path: "video/demo.mp4",
            contentType: "video/mp4",
            sizeBytes: 100 * 1024 * 1024,
          },
          ...Array.from({ length: 3 }, (_, index) => ({
            path: `images/large-${index}.png`,
            contentType: "image/png",
            sizeBytes: 10 * 1024 * 1024,
          })),
        ],
      }),
    ).toThrow(/complete bundle/);
    expect(MAX_BUNDLE_BYTES).toBe(125 * 1024 * 1024);
  });
});
