import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { internalError } from "@/lib/api/responses";

type RequestDiagnostic = {
  requestId: string;
  route: string;
  method: string;
  uploadIntentId?: string;
  fileId?: string;
  errorType?: string;
  errorCode?: string;
};

const requests = new AsyncLocalStorage<RequestDiagnostic>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const errorTypes = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AbortError",
  "TimeoutError",
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
const errorCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EACCES",
  "ENOSPC",
  "ENOENT",
  "EEXIST",
  "23505",
  "23503",
  "40001",
  "40P01",
  "53300",
  "57P01",
  "AccessDenied",
  "NoSuchKey",
  "NoSuchBucket",
  "SlowDown",
  "ServiceUnavailable",
  "INVALID_FILE_TYPE",
  "FILE_TOO_LARGE",
  "EMPTY_FILE",
  "UPLOAD_KIND_DISABLED",
  "UPLOAD_KIND_MISMATCH",
  "SIZE_MISMATCH",
]);

/** Attach identifiers only after validation; never attach filenames, keys or user data. */
export function recordUploadResource(key: "uploadIntentId" | "fileId", value: string): void {
  const context = requests.getStore();
  if (context && uuid.test(value)) context[key] = value;
}

/** Error names/codes are allowlisted because third-party errors may contain credentials. */
export function recordRequestError(error: unknown): void {
  const context = requests.getStore();
  if (!context) return;
  context.errorType = "UnknownError";
  if (error instanceof Error) {
    const name = error.constructor.name;
    context.errorType = errorTypes.has(name) ? name : "Error";
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && errorCodes.has(code)) context.errorCode = code;
  }
}

/** route must be a literal route template, never a request URL or user input. */
export function withRequestDiagnostics<Args extends unknown[]>(
  route: string,
  handler: (request: Request, ...args: Args) => Promise<Response>,
  errorResponse: (error: unknown) => Response = internalError,
): (request: Request, ...args: Args) => Promise<Response> {
  return async (request, ...args) => {
    const startedAt = performance.now();
    const context: RequestDiagnostic = {
      requestId: randomUUID(),
      route,
      method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(request.method)
        ? request.method
        : "OTHER",
    };
    return requests.run(context, async () => {
      // Only copy UUIDs from matching path positions. Query strings, tokens and raw paths
      // are intentionally excluded, including on the local signed body endpoints.
      const template = route.split("/");
      const pathname = new URL(request.url).pathname.split("/");
      if (
        template.length === pathname.length &&
        template.every(
          (part, index) => part === "[id]" || part === "[fileId]" || part === pathname[index],
        )
      ) {
        for (const [index, part] of template.entries()) {
          if (part === "[id]") recordUploadResource("uploadIntentId", pathname[index] ?? "");
          if (part === "[fileId]") recordUploadResource("fileId", pathname[index] ?? "");
        }
      }
      let response: Response;
      try {
        response = await handler(request, ...args);
      } catch (error) {
        recordRequestError(error);
        response = errorResponse(error);
      }
      response.headers.set("x-request-id", context.requestId);
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "request_complete",
        ...context,
        status: response.status,
        durationMs: Math.round(performance.now() - startedAt),
      });
      if (response.status >= 500) console.error(entry);
      else if (response.status >= 400) console.warn(entry);
      else console.info(entry);
      return response;
    });
  };
}
