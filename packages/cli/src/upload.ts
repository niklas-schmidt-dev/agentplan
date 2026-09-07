import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { ApiError } from "./api.js";

export async function uploadProviderFile(
  filePath: string,
  sizeBytes: number,
  upload: { method: string; url: string; headers: Record<string, string> },
): Promise<void> {
  const headers = new Headers(upload.headers);
  headers.set("content-length", String(sizeBytes));
  let response: Response;
  try {
    response = await fetch(upload.url, {
      method: upload.method,
      headers,
      body: Readable.toWeb(createReadStream(filePath)),
      redirect: "error",
      referrerPolicy: "no-referrer",
      credentials: "omit",
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  } catch (error) {
    throw new ApiError(0, "STORAGE_UPLOAD_FAILED", `Storage upload failed: ${String(error)}`);
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      "STORAGE_UPLOAD_FAILED",
      `Storage upload failed (${response.status}).`,
    );
  }
}
