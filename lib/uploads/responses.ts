import {
  apiError,
  internalError,
  invalidRequest,
  limitErrorResponse,
  notFound,
} from "@/lib/api/responses";
import {
  DraftNotFoundError,
  PasswordRequiredError,
  PasswordVisibilityConflictError,
} from "@/lib/drafts/service";
import { MediaValidationError } from "@/lib/validation/media";
import { recordRequestError } from "@/lib/diagnostics/request";
import {
  UploadIntentConflictError,
  UploadIntentExpiredError,
  UploadIntentNotFoundError,
} from "./service";

export function uploadErrorResponse(error: unknown): Response {
  recordRequestError(error);
  if (error instanceof UploadIntentNotFoundError || error instanceof DraftNotFoundError) {
    return notFound();
  }
  if (error instanceof PasswordRequiredError || error instanceof PasswordVisibilityConflictError) {
    return invalidRequest(error.message);
  }
  if (error instanceof UploadIntentExpiredError) {
    return apiError(410, "UPLOAD_INTENT_EXPIRED", "The upload reservation has expired.");
  }
  if (error instanceof UploadIntentConflictError) {
    const response = apiError(
      409,
      "UPLOAD_INTENT_CONFLICT",
      error.message || "The upload cannot be changed in its current state.",
    );
    if (error.retryAfter) response.headers.set("Retry-After", String(error.retryAfter));
    return response;
  }
  if (error instanceof MediaValidationError) {
    return apiError(400, error.code, error.message);
  }
  const limited = limitErrorResponse(error);
  if (limited) return limited;
  return internalError();
}
