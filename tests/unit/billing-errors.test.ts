import { describe, expect, it } from "vitest";
import { billingErrorSummary } from "@/lib/billing/errors";

describe("billing error diagnostics", () => {
  it("keeps the HTTP status without SDK credentials or customer data", () => {
    const error = Object.assign(new Error("secret response body"), {
      statusCode: 422,
      request: { headers: { authorization: "Bearer private-token" } },
      body: { customer_email: "private@example.com" },
    });
    expect(billingErrorSummary(error)).toEqual({ statusCode: 422 });
  });

  it.each([
    null,
    "private-token",
    new Error("private-token"),
    { statusCode: "private-token" },
    { statusCode: 999 },
  ])("omits unrecognized errors and status values", (error) =>
    expect(billingErrorSummary(error)).toEqual({}),
  );
});
