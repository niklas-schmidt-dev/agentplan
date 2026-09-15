/** Only fixed descriptions leave this module. Never serialize exception text or SDK payloads. */
const reasons: Record<string, string> = {
  ECONNREFUSED: "Connection was refused.",
  ECONNRESET: "Connection was reset.",
  ETIMEDOUT: "Connection timed out.",
  ENOTFOUND: "Host lookup failed.",
  EACCES: "Filesystem access was denied.",
  ENOSPC: "Temporary storage is full.",
  ENOENT: "A required file is missing.",
  EEXIST: "A file already exists.",
  ERR_MODULE_NOT_FOUND: "A required server module is missing from the deployment.",
  MODULE_NOT_FOUND: "A required server module is missing from the deployment.",
  "23502": "A required database value is missing.",
  "23505": "Database unique constraint was violated.",
  "23503": "Database referenced record is missing.",
  "23514": "Database check constraint was violated.",
  "40001": "Database transaction needs a retry.",
  "40P01": "Database transaction deadlocked.",
  "42P01": "Database table is missing.",
  "42703": "Database column is missing.",
  "42601": "Database query has invalid syntax.",
  "42501": "Database access was denied.",
  "53300": "Database connection limit was reached.",
  "57P01": "Database is shutting down.",
  "57014": "Database query was cancelled or timed out.",
  "28P01": "Database authentication failed.",
  AccessDenied: "Storage access was denied.",
  InvalidAccessKeyId: "Storage credentials were rejected.",
  SignatureDoesNotMatch: "Storage request signature was rejected.",
  NoSuchKey: "Stored object is missing.",
  NotFound: "Stored object was not found.",
  NoSuchBucket: "Storage bucket is missing.",
  SlowDown: "Storage provider is rate limiting requests.",
  ServiceUnavailable: "Storage provider is unavailable.",
  BlobAccessError: "Blob storage access was denied.",
  BlobNotFoundError: "Blob object is missing.",
  BlobStoreNotFoundError: "Blob store is missing.",
  BlobStoreSuspendedError: "Blob store is suspended.",
  BlobServiceNotAvailable: "Blob storage service is unavailable.",
  BlobRequestAbortedError: "Blob storage request was aborted.",
  BlobServiceRateLimited: "Blob storage service is rate limiting requests.",
  INVALID_FILE_TYPE: "Stored file type is invalid.",
  FILE_TOO_LARGE: "File exceeds the upload size limit.",
  EMPTY_FILE: "Uploaded file is empty.",
  UPLOAD_KIND_DISABLED: "This upload kind is disabled.",
  UPLOAD_KIND_MISMATCH: "Upload kind does not match its reservation.",
  SIZE_MISMATCH: "Stored file size does not match its reservation.",
};
const types = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "DrizzleQueryError",
  "DatabaseError",
  "S3ServiceException",
  "UploadIntentNotFoundError",
  "UploadIntentExpiredError",
  "UploadIntentConflictError",
  "DraftNotFoundError",
  "DraftWriteConflictError",
  "PasswordRequiredError",
  "PasswordVisibilityConflictError",
  "MediaValidationError",
  "QuotaExceededError",
  "RateLimitedError",
]);

// Exception objects can have throwing accessors. Diagnostics must not hide the original error.
function field(value: unknown, key: string): unknown {
  try {
    return (typeof value === "object" && value !== null) || typeof value === "function"
      ? Reflect.get(value, key)
      : undefined;
  } catch {
    return undefined;
  }
}
function knownReason(value: unknown): value is string {
  return typeof value === "string" && Object.hasOwn(reasons, value);
}
function knownType(value: unknown): value is string {
  return typeof value === "string" && (types.has(value) || knownReason(value));
}

type SafeError = { type: string; code?: string; summary?: string; httpStatus?: number };

function describe(error: unknown): SafeError {
  const name = field(error, "name");
  const constructorName = field(field(error, "constructor"), "name");
  const code = field(error, "code");
  const safeCode = knownReason(code) ? code : knownReason(name) ? name : undefined;
  const status =
    field(field(error, "$metadata"), "httpStatusCode") ??
    field(error, "statusCode") ??
    field(error, "status");
  return {
    type:
      knownType(name) && name !== "Error"
        ? name
        : knownType(constructorName)
          ? constructorName
          : error instanceof Error
            ? "Error"
            : "UnknownError",
    ...(safeCode ? { code: safeCode, summary: reasons[safeCode] } : {}),
    ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
      ? { httpStatus: status }
      : {}),
  };
}

export function safeErrorDetails(error: unknown) {
  const chain: SafeError[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current != null && !seen.has(current) && chain.length < 5) {
    seen.add(current);
    chain.push(describe(current));
    current = field(current, "cause");
  }
  const root = chain[0] ?? { type: "UnknownError" };
  const reason = chain.findLast((entry) => entry.code);
  return {
    errorType: root.type,
    ...(reason ? { errorCode: reason.code, errorSummary: reason.summary } : {}),
    ...(root.httpStatus ? { errorHttpStatus: root.httpStatus } : {}),
    ...(chain.length > 1 ? { errorCauses: chain.slice(1) } : {}),
  };
}
