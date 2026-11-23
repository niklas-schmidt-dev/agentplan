import { afterEach, describe, expect, it, vi } from "vitest";
import { appUrl, safeReturnPath } from "@/lib/urls";

describe("appUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("prefers an explicitly configured URL", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://plans.example.test///");
    vi.stubEnv("VERCEL_URL", "preview.vercel.app");

    expect(appUrl()).toBe("https://plans.example.test");
  });

  it("uses the stable Vercel project URL in production", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "build-placeholder");
    vi.stubEnv("BETTER_AUTH_URL", "build-placeholder");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_URL", "agentplan-build.vercel.app");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "agentplan.vercel.app");

    expect(appUrl()).toBe("https://agentplan.vercel.app");
  });

  it("uses the current Vercel deployment for previews", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("BETTER_AUTH_URL", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_URL", "agentplan-preview.vercel.app");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "agentplan.vercel.app");

    expect(appUrl()).toBe("https://agentplan-preview.vercel.app");
  });
});

describe("safeReturnPath", () => {
  it("keeps same-origin paths with their query and hash", () => {
    expect(safeReturnPath("/p/abc123")).toBe("/p/abc123");
    expect(safeReturnPath("/p/abc/v/123?x=1#top")).toBe("/p/abc/v/123?x=1#top");
  });

  it.each([
    undefined,
    ["/p/abc"],
    "",
    "p/abc",
    "https://evil.example/p/abc",
    "//evil.example",
    "/.//evil.example",
    "/a/..//evil.example",
    "/%2e//evil.example",
    "/p/archived%2Fcopy",
    "/p/a%5cb",
    "/\\evil.example",
    "/\tevil.example",
    "javascript:alert(1)",
  ])("rejects %j", (value) => {
    expect(safeReturnPath(value)).toBeUndefined();
  });
});
