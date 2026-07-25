import { describe, expect, it } from "vitest";
import { etagMatches, parseSingleByteRange } from "@/lib/http/range";

describe("parseSingleByteRange", () => {
  it("parses bounded, open-ended, and suffix ranges", () => {
    expect(parseSingleByteRange("bytes=10-19", 100)).toEqual({
      ok: true,
      start: 10,
      end: 19,
    });
    expect(parseSingleByteRange("bytes=90-", 100)).toEqual({
      ok: true,
      start: 90,
      end: 99,
    });
    expect(parseSingleByteRange("bytes=-10", 100)).toEqual({
      ok: true,
      start: 90,
      end: 99,
    });
  });

  it("rejects invalid, multiple, and unsatisfiable ranges", () => {
    for (const value of ["bytes=20-10", "bytes=100-", "bytes=0-1,3-4", "items=0-1"]) {
      expect(parseSingleByteRange(value, 100)).toEqual({ ok: false });
    }
  });
});

describe("etagMatches", () => {
  it("matches lists, weak validators, and wildcard conditions", () => {
    expect(etagMatches('"old", W/"current"', '"current"')).toBe(true);
    expect(etagMatches("*", '"current"')).toBe(true);
    expect(etagMatches('"other"', '"current"')).toBe(false);
  });
});
