import { describe, expect, it } from "vitest";
import { parseExpiryDuration, validateExpirySeconds } from "@agentplan/upload-contract";
import { draftExpirySchema } from "@/lib/validation/api";

describe("published draft lifetimes", () => {
  it.each([
    ["1m", 60],
    ["1h", 3600],
    ["1d", 86400],
    ["30d", 2592000],
    ["365d", 31536000],
  ])("parses %s", (input, seconds) => {
    expect(parseExpiryDuration(String(input))).toBe(seconds);
  });

  it.each(["", "0h", "-1d", "1.5h", "Infinity", "366d", "9999999999999999d", "1h later"])(
    "rejects invalid duration %s",
    (input) => {
      expect(() => parseExpiryDuration(input)).toThrow();
    },
  );

  it.each([0, -1, 59, 60.5, NaN, Infinity, 31536001, "3600"])(
    "rejects invalid API lifetime %s",
    (value) => {
      expect(draftExpirySchema.safeParse(value).success).toBe(false);
    },
  );

  it("keeps expiry opt-in", () => {
    expect(validateExpirySeconds()).toBeNull();
    expect(validateExpirySeconds(null)).toBeNull();
    expect(draftExpirySchema.safeParse(undefined).success).toBe(true);
    expect(draftExpirySchema.safeParse(null).success).toBe(true);
  });
});
