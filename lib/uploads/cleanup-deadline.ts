// A server copy admitted just before intent expiry can still finish after a
// cancellation. Retain its cleanup job beyond the completion execution budget.
export function finalObjectCleanupDeadline(intent: { expiresAt: Date; mode: string }): Date {
  return intent.mode === "bundle"
    ? intent.expiresAt
    : new Date(intent.expiresAt.getTime() + 6 * 60 * 1000);
}
