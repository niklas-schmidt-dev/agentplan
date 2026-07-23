import { describe, expect, it } from "vitest";
import { readUpload } from "@/lib/api/upload";
import { MAX_UPLOAD_BYTES } from "@/lib/validation/upload";

function uploadRequest(headers: Record<string, string>, body?: FormData): Request {
  return new Request("http://localhost/api/v1/drafts", { method: "POST", headers, body });
}

describe("readUpload request-size precheck", () => {
  it("rejects a declared-oversized body with 413 before parsing", async () => {
    const result = await readUpload(
      uploadRequest({
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(MAX_UPLOAD_BYTES * 4),
      }),
    );

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FILE_TOO_LARGE");
  });

  it("accepts a small valid multipart upload", async () => {
    const form = new FormData();
    form.set("file", new File(["<!doctype html><h1>ok</h1>"], "plan.html", { type: "text/html" }));

    const result = await readUpload(uploadRequest({}, form));
    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.title).toBe("Plan");
      expect(result.bytes.byteLength).toBeGreaterThan(0);
    }
  });
});
