import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  unstable_doesMiddlewareMatch,
  unstable_getResponseFromNextConfig,
} from "next/experimental/testing/server";
import nextConfig from "@/next.config";
import { config, proxy } from "@/proxy";

afterEach(() => vi.unstubAllEnvs());

describe("application response hardening", () => {
  it("applies security headers to application pages and auth-aware caching to API routes", async () => {
    const home = await unstable_getResponseFromNextConfig({
      url: "https://agentplan.test/",
      nextConfig,
    });
    expect(Object.fromEntries(home.headers)).toMatchObject({
      "strict-transport-security": "max-age=63072000; includeSubDomains",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "cross-origin-opener-policy": "same-origin",
    });
    const api = await unstable_getResponseFromNextConfig({
      url: "https://agentplan.test/api/v1/drafts",
      nextConfig,
    });
    expect(api.headers.get("cache-control")).toBe("private, no-store");
    expect(api.headers.get("vary")).toBe("Authorization, Cookie");
  });

  it("issues a fresh script nonce per request and forwards the matching policy to Next.js", () => {
    vi.stubEnv("NODE_ENV", "production");
    const policies = Array.from({ length: 2 }, () => {
      const response = proxy(new NextRequest("https://agentplan.test/dashboard"));
      const nonce = response.headers.get("x-middleware-request-x-nonce");
      expect(nonce).toBeTruthy();
      const policy = response.headers.get("content-security-policy")!;
      expect(policy).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
      expect(policy).not.toContain("'unsafe-eval'");
      expect(
        policy.split("; ").find((directive) => directive.startsWith("script-src")),
      ).not.toContain("'unsafe-inline'");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).toContain("media-src 'self'");
      expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(policy);
      return policy;
    });
    expect(policies[0]).not.toBe(policies[1]);
  });

  it.each(["/p/plan/content", "/p/plan/content/", "/p/plan/v/version/nested/index.html"])(
    "leaves the content route's sandbox policy intact for %s",
    (pathname) => {
      const response = proxy(new NextRequest(`https://agentplan.test${pathname}`));
      expect(response.headers.get("content-security-policy")).toBeNull();
      expect(response.headers.get("x-middleware-request-x-nonce")).toBeNull();
    },
  );

  it.each(["/", "/dashboard", "/p/plan", "/p/plan/v/version"])(
    "applies the application policy to %s",
    (pathname) => {
      const url = `https://agentplan.test${pathname}`;
      expect(unstable_doesMiddlewareMatch({ config, nextConfig, url })).toBe(true);
      expect(proxy(new NextRequest(url)).headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'",
      );
    },
  );
});
