import { apiError, invalidRequest } from "@/lib/api/responses";
import { draftFieldsSchema } from "@/lib/validation/api";
import { MAX_UPLOAD_BYTES, titleFromFilename, validateUpload } from "@/lib/validation/upload";
import type { Visibility } from "@/db/schema";

// Allowance for multipart framing and the small metadata fields.
const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 64 * 1024;

export type ParsedUpload = {
  bytes: Uint8Array;
  title: string;
  visibility: Visibility | undefined;
  password: string | undefined;
};

async function boundedRequest(req: Request): Promise<Request | Response> {
  if (!req.body) return req;

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return apiError(
          413,
          "FILE_TOO_LARGE",
          `The file exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB limit.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body,
  });
}

/** Parses and validates a multipart upload. Returns a Response on rejection. */
export async function readUpload(req: Request): Promise<ParsedUpload | Response> {
  // Reject declared-oversized bodies before buffering a single byte.
  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return apiError(
      413,
      "FILE_TOO_LARGE",
      `The file exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB limit.`,
    );
  }

  const bounded = await boundedRequest(req);
  if (bounded instanceof Response) return bounded;

  let form: FormData;
  try {
    form = await bounded.formData();
  } catch {
    return invalidRequest("Expected multipart/form-data with a file field.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return invalidRequest("Missing file field.");
  }

  const validationError = validateUpload({
    filename: file.name,
    contentType: file.type || null,
    sizeBytes: file.size,
  });
  if (validationError) {
    const status = validationError.code === "FILE_TOO_LARGE" ? 413 : 400;
    return apiError(status, validationError.code, validationError.message);
  }

  const titleField = form.get("title");
  const visibilityField = form.get("visibility");
  const passwordField = form.get("password");
  const fields = draftFieldsSchema.safeParse({
    title: typeof titleField === "string" && titleField ? titleField : undefined,
    visibility: typeof visibilityField === "string" && visibilityField ? visibilityField : undefined,
    password: typeof passwordField === "string" && passwordField ? passwordField : undefined,
  });
  if (!fields.success) {
    return invalidRequest(fields.error.issues[0]?.message ?? "Invalid fields.");
  }

  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    title: fields.data.title ?? titleFromFilename(file.name),
    visibility: fields.data.visibility,
    password: fields.data.password,
  };
}
