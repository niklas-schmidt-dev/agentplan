/** SDK errors can contain request headers, credentials, and customer payloads. */
export function billingErrorSummary(error: unknown): { statusCode?: number } {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return {};
  const statusCode = error.statusCode;
  return typeof statusCode === "number" &&
    Number.isInteger(statusCode) &&
    statusCode >= 100 &&
    statusCode <= 599
    ? { statusCode }
    : {};
}
