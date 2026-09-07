import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { ApiError } from "./api.js";

export async function uploadProviderFile(
  filePath: string,
  sizeBytes: number,
  upload: { method: string; url: string; headers: Record<string, string> },
  timeoutMs = 15 * 60_000,
): Promise<void> {
  const headers = new Headers(upload.headers);
  headers.set("content-length", String(sizeBytes));
  const stream = createReadStream(filePath);
  let response: Response;
  try {
    response = await fetch(upload.url, {
      method: upload.method,
      headers,
      body: Readable.toWeb(stream),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      referrerPolicy: "no-referrer",
      credentials: "omit",
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  } catch {
    throw new ApiError(
      0,
      "STORAGE_UPLOAD_FAILED",
      "Storage transfer failed or exceeded its deadline.",
    );
  } finally {
    stream.destroy();
  }
  await response.body?.cancel();
  if (!response.ok) {
    throw new ApiError(
      response.status,
      "STORAGE_UPLOAD_FAILED",
      `Storage upload failed (${response.status}).`,
    );
  }
}
