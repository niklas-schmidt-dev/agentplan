import { QuotaExceededError, RateLimitedError } from "@/lib/limits/errors";

export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "INSUFFICIENT_SCOPE"
  | "NOT_FOUND"
  | "INVALID_REQUEST"
  | "INVALID_FILE_TYPE"
  | "FILE_TOO_LARGE"
  | "EMPTY_FILE"
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

// Error codes are part of the public contract — agents match on them. Add new
// codes freely; never rename or repurpose existing ones.
export function apiError(status: number, code: ApiErrorCode, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export const unauthorized = (): Response =>
  apiError(401, "UNAUTHORIZED", "A valid session or API token is required.");

export const insufficientScope = (scope: string): Response =>
  apiError(403, "INSUFFICIENT_SCOPE", `This action requires the ${scope} scope.`);

export const notFound = (): Response => apiError(404, "NOT_FOUND", "Not found.");

export const invalidRequest = (message: string): Response =>
  apiError(400, "INVALID_REQUEST", message);

export const internalError = (): Response =>
  apiError(500, "INTERNAL_ERROR", "Something went wrong.");

/** Maps quota/rate-limit errors to their API responses; null for anything else. */
export function limitErrorResponse(error: unknown): Response | null {
  if (error instanceof QuotaExceededError) {
    return apiError(403, "QUOTA_EXCEEDED", error.message);
  }
  if (error instanceof RateLimitedError) {
    const response = apiError(
      429,
      "RATE_LIMITED",
      `Rate limit exceeded. Retry in ${error.retryAfterSeconds} seconds.`,
    );
    response.headers.set("Retry-After", String(error.retryAfterSeconds));
    return response;
  }
  return null;
}
