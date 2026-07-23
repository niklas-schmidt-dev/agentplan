import { describe, expect, it } from "vitest";
import { isSafeHttpUrl, normalizeApiBaseUrl } from "@/packages/cli/src/url";

describe("normalizeApiBaseUrl (bearer-token destination guard)", () => {
  it("accepts HTTPS and strips one trailing slash", () => {
    expect(normalizeApiBaseUrl("https://agentplan.app/")).toBe("https://agentplan.app");
  });

  it("permits HTTP only for local development", () => {
    expect(normalizeApiBaseUrl("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(() => normalizeApiBaseUrl("http://agentplan.app")).toThrow(/HTTPS/);
    expect(() => normalizeApiBaseUrl("http://192.168.1.10:3000")).toThrow(/HTTPS/);
  });

  it("rejects credentials, query strings, fragments, and malformed input", () => {
    for (const url of [
      "https://token@example.com",
      "https://example.com?forward=elsewhere",
      "https://example.com#fragment",
      "not a url",
    ]) {
      expect(() => normalizeApiBaseUrl(url), url).toThrow();
    }
  });
});

describe("isSafeHttpUrl (agentplan open injection guard)", () => {
  it("accepts normal agentplan URLs", () => {
    expect(isSafeHttpUrl("https://agentplan.app/p/launch-plan-x7k2")).toBe(true);
    expect(isSafeHttpUrl("http://localhost:3000/p/smoke-plan-m3wu")).toBe(true);
  });

  it("rejects non-http(s) schemes", () => {
    expect(isSafeHttpUrl("http://agentplan.app/p/cleartext")).toBe(false);
    expect(isSafeHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("data:text/html,<script>1</script>")).toBe(false);
  });

  it("rejects shell and cmd metacharacters", () => {
    for (const url of [
      "https://x.app/p/a & calc.exe",
      "https://x.app/p/a&whoami",
      "https://x.app/p/a|id",
      "https://x.app/p/a;rm -rf",
      "https://x.app/p/$(reboot)",
      "https://x.app/p/%USERPROFILE%",
      "https://x.app/p/a^b",
      "https://x.app/p/a`b`",
      'https://x.app/p/a"b',
    ]) {
      expect(isSafeHttpUrl(url), url).toBe(false);
    }
  });

  it("rejects malformed input", () => {
    expect(isSafeHttpUrl("not a url")).toBe(false);
    expect(isSafeHttpUrl("")).toBe(false);
  });
});
