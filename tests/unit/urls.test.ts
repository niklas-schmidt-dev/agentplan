import { afterEach, describe, expect, it, vi } from "vitest";
import { appUrl } from "@/lib/urls";

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
