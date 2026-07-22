export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MiB

export type UploadErrorCode = "INVALID_FILE_TYPE" | "FILE_TOO_LARGE" | "EMPTY_FILE";

export type UploadValidationError = { code: UploadErrorCode; message: string };

const HTML_EXTENSIONS = [".html", ".htm"];

export function validateUpload(input: {
  filename: string;
  contentType: string | null;
  sizeBytes: number;
}): UploadValidationError | null {
  const lower = input.filename.toLowerCase();
  if (!HTML_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return { code: "INVALID_FILE_TYPE", message: "Only HTML files are supported." };
  }
  // Browsers infer text/html from the extension; an explicitly different type is rejected.
  if (input.contentType) {
    const mime = input.contentType.split(";")[0]?.trim().toLowerCase();
    if (mime !== "text/html") {
      return { code: "INVALID_FILE_TYPE", message: "Only HTML files are supported." };
    }
  }
  if (input.sizeBytes <= 0) {
    return { code: "EMPTY_FILE", message: "The file is empty." };
  }
  if (input.sizeBytes > MAX_UPLOAD_BYTES) {
    return {
      code: "FILE_TOO_LARGE",
      message: `The file exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB limit.`,
    };
  }
  return null;
}

/** Display title derived from a filename — never used as a storage key. */
export function titleFromFilename(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "";
  const withoutExt = base.replace(/\.(html?|HTML?)$/, "");
  const cleaned = withoutExt.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return "Untitled plan";
  return (cleaned.charAt(0).toUpperCase() + cleaned.slice(1)).slice(0, 200);
}

export function normalizeTitle(title: string): string {
  const cleaned = title.replace(/\s+/g, " ").trim().slice(0, 200);
  return cleaned || "Untitled plan";
}
