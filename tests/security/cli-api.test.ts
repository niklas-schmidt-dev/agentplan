import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPlanApi } from "@/packages/cli/src/api";

describe("AgentPlanApi transport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses redirect following on bearer-authenticated requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ap_live_test");
      return Response.json({ drafts: [] });
    });

    const api = new AgentPlanApi("https://agentplan.app", "ap_live_test");
    await expect(api.listDrafts()).resolves.toEqual({ drafts: [] });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

describe("CLI direct storage transport", () => {
  it("streams files through a credential-free, no-redirect request", () => {
    const source = readFileSync("packages/cli/src/index.ts", "utf8");
    expect(source).toContain("body: createReadStream(filePath)");
    expect(source).toContain('credentials: "omit"');
    expect(source).toContain('redirect: "error"');
    expect(source).toContain('referrerPolicy: "no-referrer"');
    expect(source).toContain('headers.set("content-length", String(sizeBytes))');
  });
});
import { readFileSync } from "node:fs";
