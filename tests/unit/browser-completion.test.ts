import { afterEach, describe, expect, it, vi } from "vitest";
import { completeBrowserUpload, UncertainCompletionError } from "@/lib/uploads/browser-completion";

const response = (body: unknown, status = 200) => Response.json(body, { status });

describe("browser completion reconciliation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns the original draft after a lost completion response", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValueOnce(
        response({ intent: { status: "completed" }, draft: { id: "original" } }),
      );
    vi.stubGlobal("fetch", fetch);
    expect(await completeBrowserUpload("/intents/original")).toMatchObject({
      draft: { id: "original" },
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/intents/original/complete",
      "/intents/original",
    ]);
  });

  it("retains the same intent when status cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(completeBrowserUpload("/intents/original")).rejects.toMatchObject({
      path: "/intents/original",
    });
  });

  it("preserves the server validation error for a failed intent", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response({ error: { message: "Stored content is not valid image/png." } }, 400),
        )
        .mockResolvedValueOnce(
          response({ intent: { status: "failed", failureCode: "INVALID_FILE_TYPE" } }),
        ),
    );
    await expect(completeBrowserUpload("/intents/original")).rejects.toThrow(
      "Stored content is not valid image/png.",
    );
  });

  it("bounds retry attempts on an active lease without creating or cancelling intents", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockImplementation(async (url: string) =>
        url.endsWith("/complete")
          ? response({ error: { code: "UPLOAD_INTENT_CONFLICT" } }, 409)
          : response({ intent: { status: "pending" } }),
      );
    vi.stubGlobal("fetch", fetch);
    const result = completeBrowserUpload("/intents/original").catch((error) => error);
    await vi.runAllTimersAsync();
    expect(await result).toBeInstanceOf(UncertainCompletionError);
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(fetch.mock.calls.every(([url]) => url.startsWith("/intents/original"))).toBe(true);
  });
});
