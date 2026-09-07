import { ApiError, type ApiDraft, type ApiVersion, type UploadStatus } from "./api.js";

function completionRetryDelay(error: unknown): number | null {
  if (!(error instanceof ApiError)) return null;
  const transient =
    error.status === 0 ||
    error.status === 408 ||
    error.status === 429 ||
    error.status >= 500 ||
    error.code === "BAD_RESPONSE" ||
    (error.status === 409 && error.code === "UPLOAD_INTENT_CONFLICT");
  if (!transient) return null;
  if (!error.retryAfter) return 500;
  const seconds = Number(error.retryAfter);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(error.retryAfter) - Date.now();
  // Keep automatic recovery bounded; longer server-requested delays require
  // explicit recovery with the retained intent ID instead of an early retry.
  if (Number.isFinite(delay) && delay > 30_000) return null;
  return Number.isFinite(delay) ? Math.max(500, delay) : 500;
}

/** Never cancel or create a replacement after an ambiguous completion response. */
export async function completeWithRecovery(
  intentId: string,
  complete: () => Promise<{ draft: ApiDraft; version: ApiVersion }>,
  status: () => Promise<UploadStatus>,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<{ draft: ApiDraft; version: ApiVersion }> {
  try {
    return await complete();
  } catch (initialError) {
    let error = initialError;
    let retried = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await pause(500 * 2 ** (attempt - 1));
      const result = await status().catch((statusError: unknown) => {
        if (statusError instanceof ApiError && [404, 410].includes(statusError.status)) {
          throw statusError;
        }
        return null;
      });
      if (result?.intent.status === "completed" && result.draft && result.version) {
        return { draft: result.draft, version: result.version };
      }
      if (result && ["failed", "cancelled"].includes(result.intent.status)) throw error;
      // Give an overlapping completion a chance to finish before retrying.
      // The same intent is idempotent and the server fences concurrent workers.
      const retryDelay = completionRetryDelay(error);
      if (result?.intent.status === "pending" && attempt >= 1 && !retried && retryDelay !== null) {
        retried = true;
        await pause(retryDelay);
        try {
          return await complete();
        } catch (retryError) {
          error = retryError;
        }
      }
    }
    throw new ApiError(
      error instanceof ApiError ? error.status : 0,
      "UPLOAD_COMPLETION_UNCERTAIN",
      `Upload completion could not be confirmed. Keep intent ${intentId}; inspect it with agentplan upload-status ${intentId} before retrying (add --bundle for a directory upload).`,
      error instanceof ApiError ? error.requestId : undefined,
      error instanceof ApiError ? error.retryAfter : undefined,
      intentId,
    );
  }
}
