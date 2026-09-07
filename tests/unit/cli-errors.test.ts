import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, AgentPlanApi } from "@/packages/cli/src/api";
import { CliError, writeError } from "@/packages/cli/src/errors";

afterEach(() => vi.restoreAllMocks());

describe("CLI structured diagnostics", () => {
  it("retains request IDs and Retry-After for rate-limited API requests", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        { error: { code: "RATE_LIMITED", message: "Try later" } },
        { status: 429, headers: { "x-request-id": "request-1", "retry-after": "12" } },
      ),
    );
    await expect(
      new AgentPlanApi("https://agentplan.app", "test").listDrafts(),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      requestId: "request-1",
      retryAfter: "12",
      status: 429,
    });
  });

  it.each([null, "oops", 1])("handles malformed error bodies: %s", async (body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body, { status: 502 }));
    await expect(
      new AgentPlanApi("https://agentplan.app", "test").listDrafts(),
    ).rejects.toMatchObject({ code: "UNKNOWN_ERROR", status: 502 });
  });

  it("writes one JSON error to stderr and redacts credential-bearing diagnostics", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(
      writeError(
        new ApiError(
          503,
          "SERVER_ERROR",
          "ap_live_example https://storage.example/path?signature=secret",
          "req-1",
          "5",
        ),
        true,
      ),
    ).toBe(1);
    const result = JSON.parse(String(stderr.mock.calls[0]![0]));
    expect(result.error).toMatchObject({
      code: "SERVER_ERROR",
      requestId: "req-1",
      retryAfter: "5",
      status: 503,
    });
    expect(result.error.message).not.toContain("signature");
    expect(result.error.message).not.toContain("ap_live_");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("uses exit status 2 for local usage errors", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(writeError(new CliError("Missing file"), true)).toBe(2);
  });

  it("gives validation and restores their full route budget while bounding ordinary calls", async () => {
    const deadlines = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ draft: {}, version: {} }),
    );
    const api = new AgentPlanApi("https://agentplan.app", "test");
    await api.identity();
    await api.completeUploadIntent("single");
    await api.completeBundle("bundle");
    await api.restoreVersion("draft", "version");
    expect(deadlines.mock.calls.map(([timeout]) => timeout)).toEqual([
      30_000, 310_000, 310_000, 310_000,
    ]);
  });

  it("bounds API requests with an abort signal", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ userId: "owner", scopes: ["drafts:write"] });
    });
    await expect(
      new AgentPlanApi("https://agentplan.app", "test").identity(),
    ).resolves.toMatchObject({ scopes: ["drafts:write"] });
    expect(fetch.mock.calls[0]![0]).toBe("https://agentplan.app/api/v1/identity");
  });
});
