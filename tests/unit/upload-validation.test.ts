import { describe, expect, it } from "vitest";
import {
  MAX_UPLOAD_BYTES,
  titleFromFilename,
  validateUpload,
} from "@/lib/validation/upload";

describe("validateUpload", () => {
  const ok = { filename: "plan.html", contentType: "text/html", sizeBytes: 100 };

  it("accepts a normal HTML file", () => {
    expect(validateUpload(ok)).toBeNull();
  });

  it("accepts .htm and charset params and missing content type", () => {
    expect(validateUpload({ ...ok, filename: "plan.htm" })).toBeNull();
    expect(validateUpload({ ...ok, contentType: "text/html; charset=utf-8" })).toBeNull();
    expect(validateUpload({ ...ok, contentType: null })).toBeNull();
  });

  it("rejects non-HTML extensions", () => {
    for (const filename of ["plan.pdf", "plan.svg", "plan.html.exe", "plan"]) {
      expect(validateUpload({ ...ok, filename })?.code).toBe("INVALID_FILE_TYPE");
    }
  });

  it("rejects explicitly non-HTML content types", () => {
    expect(validateUpload({ ...ok, contentType: "image/svg+xml" })?.code).toBe(
      "INVALID_FILE_TYPE",
    );
    expect(validateUpload({ ...ok, contentType: "application/octet-stream" })?.code).toBe(
      "INVALID_FILE_TYPE",
    );
  });

  it("rejects empty files", () => {
    expect(validateUpload({ ...ok, sizeBytes: 0 })?.code).toBe("EMPTY_FILE");
  });

  it("rejects oversized files", () => {
    expect(validateUpload({ ...ok, sizeBytes: MAX_UPLOAD_BYTES + 1 })?.code).toBe(
      "FILE_TOO_LARGE",
    );
    expect(validateUpload({ ...ok, sizeBytes: MAX_UPLOAD_BYTES })).toBeNull();
  });
});

describe("titleFromFilename", () => {
  it("derives a display title", () => {
    expect(titleFromFilename("launch-plan_v2.html")).toBe("Launch plan v2");
  });

  it("ignores directory components", () => {
    expect(titleFromFilename("../../etc/passwd.html")).toBe("Passwd");
  });

  it("falls back for unusable names", () => {
    expect(titleFromFilename(".html")).toBe("Untitled plan");
  });
});
