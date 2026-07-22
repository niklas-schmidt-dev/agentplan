import { describe, expect, it } from "vitest";
import { generateSlug, slugify } from "@/lib/drafts/slug";

describe("slugify", () => {
  it("lowercases and dashes", () => {
    expect(slugify("Launch Plan Q3")).toBe("launch-plan-q3");
  });

  it("strips accents and symbols", () => {
    expect(slugify("Résumé & Notes!")).toBe("resume-notes");
  });

  it("handles empty and symbol-only input", () => {
    expect(slugify("")).toBe("");
    expect(slugify("!!!")).toBe("");
  });

  it("truncates long titles", () => {
    expect(slugify("a".repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe("generateSlug", () => {
  it("appends a 4-char suffix", () => {
    expect(generateSlug("Launch plan")).toMatch(/^launch-plan-[a-z0-9]{4}$/);
  });

  it("falls back to 'draft' for unusable titles", () => {
    expect(generateSlug("???")).toMatch(/^draft-[a-z0-9]{4}$/);
  });

  it("always fits the 80-char slug column", () => {
    expect(generateSlug("x".repeat(500)).length).toBeLessThanOrEqual(80);
  });

  it("produces distinct suffixes", () => {
    const slugs = new Set(Array.from({ length: 50 }, () => generateSlug("t")));
    expect(slugs.size).toBeGreaterThan(1);
  });
});
