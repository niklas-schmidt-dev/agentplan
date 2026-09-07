export type CompletionResult = { draft: { id: string } };

export class UncertainCompletionError extends Error {
  constructor(public readonly path: string) {
    super(
      "The upload is saved, but completion could not be confirmed. Check this upload again before starting another.",
    );
  }
}

/** Reconcile the same reservation after a timeout, proxy error, or lost body. */
export async function completeBrowserUpload(path: string): Promise<CompletionResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const completion = await fetch(`${path}/complete`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(310_000),
    }).catch(() => null);
    const completed = completion ? await completion.json().catch(() => null) : null;
    if (completion?.ok && completed?.draft?.id) return completed;

    const status = await fetch(path, {
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    const body = status ? await status.json().catch(() => null) : null;
    if (status?.ok && body?.intent?.status === "completed" && body?.draft?.id) return body;
    if (
      status?.status === 410 ||
      (status?.ok && ["failed", "cancelled"].includes(body?.intent?.status))
    ) {
      throw new Error(
        completed?.error?.message ??
          body?.error?.message ??
          `Upload ${body.intent.status}: ${body.intent.failureCode ?? "please try again"}.`,
      );
    }
    // A missing/inaccessible status is ambiguous, including expired auth. Keep
    // the identity available instead of creating or cancelling a reservation.
    if (!status?.ok || body?.intent?.status !== "pending") break;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
  }
  throw new UncertainCompletionError(path);
}
