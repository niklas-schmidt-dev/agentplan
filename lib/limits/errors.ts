/** Thrown when a hard per-user quota (drafts, storage, tokens) is exhausted. */
export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

/** Thrown when a rate-limit window is exhausted; retryAfterSeconds is when it resets. */
export class RateLimitedError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Rate limit exceeded. Try again later.");
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
