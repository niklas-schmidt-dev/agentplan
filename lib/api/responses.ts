export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "INSUFFICIENT_SCOPE"
  | "NOT_FOUND"
  | "INVALID_REQUEST"
  | "INVALID_FILE_TYPE"
  | "FILE_TOO_LARGE"
  | "EMPTY_FILE"
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
