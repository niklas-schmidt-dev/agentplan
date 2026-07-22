import { apiError, invalidRequest } from "@/lib/api/responses";
import { draftFieldsSchema } from "@/lib/validation/api";
import { titleFromFilename, validateUpload } from "@/lib/validation/upload";
import type { Visibility } from "@/db/schema";

export type ParsedUpload = {
  bytes: Uint8Array;
  title: string;
  visibility: Visibility | undefined;
};

/** Parses and validates a multipart upload. Returns a Response on rejection. */
export async function readUpload(req: Request): Promise<ParsedUpload | Response> {
  let form: FormData;
  try {
    form = await req.formData();
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
  const fields = draftFieldsSchema.safeParse({
    title: typeof titleField === "string" && titleField ? titleField : undefined,
    visibility: typeof visibilityField === "string" && visibilityField ? visibilityField : undefined,
  });
  if (!fields.success) {
    return invalidRequest(fields.error.issues[0]?.message ?? "Invalid fields.");
  }

  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    title: fields.data.title ?? titleFromFilename(file.name),
    visibility: fields.data.visibility,
  };
}
