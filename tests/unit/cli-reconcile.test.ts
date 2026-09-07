import { describe, expect, it, vi } from "vitest";
import { ApiError, type ApiDraft, type ApiVersion } from "@/packages/cli/src/api";
import { completeWithRecovery } from "@/packages/cli/src/reconcile";

const draft = { id: "draft-1" } as ApiDraft;
const version = { id: "version-1" } as ApiVersion;
const pause = async () => {};

describe("CLI upload completion recovery", () => {
  it("returns the committed result after a lost completion response", async () => {
    const complete = vi.fn().mockRejectedValue(new ApiError(0, "NETWORK_ERROR", "Disconnected"));
    const status = vi.fn().mockResolvedValue({ intent: { status: "completed" }, draft, version });
    await expect(completeWithRecovery("intent-1", complete, status, pause)).resolves.toEqual({
      draft,
      version,
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledOnce();
  });

  it("polls while the original completion is still in progress", async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce({ intent: { status: "pending" } })
      .mockResolvedValue({ intent: { status: "completed" }, draft, version });
    await expect(
      completeWithRecovery(
        "intent-1",
        async () => {
          throw new Error("lost");
        },
        status,
        pause,
      ),
    ).resolves.toEqual({ draft, version });
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("preserves uncertain intents when reconciliation also fails", async () => {
    const status = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(
      completeWithRecovery(
        "intent-1",
        async () => {
          throw new ApiError(502, "BAD_RESPONSE", "Lost", "req-1");
        },
        status,
        pause,
      ),
    ).rejects.toMatchObject({
      code: "UPLOAD_COMPLETION_UNCERTAIN",
      intentId: "intent-1",
      requestId: "req-1",
    });
    expect(status).toHaveBeenCalledTimes(4);
  });

  it("retries a transient failure once on the same pending intent", async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, "INTERNAL_ERROR", "Unavailable"))
      .mockResolvedValue({ draft, version });
    const status = vi.fn().mockResolvedValue({ intent: { id: "intent-1", status: "pending" } });
    await expect(completeWithRecovery("intent-1", complete, status, pause)).resolves.toEqual({
      draft,
      version,
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("bounds same-intent retries and keeps an unresolved reservation", async () => {
    const complete = vi.fn().mockRejectedValue(new ApiError(503, "INTERNAL_ERROR", "Unavailable"));
    const status = vi.fn().mockResolvedValue({ intent: { id: "intent-1", status: "pending" } });
    await expect(completeWithRecovery("intent-1", complete, status, pause)).rejects.toMatchObject({
      code: "UPLOAD_COMPLETION_UNCERTAIN",
      intentId: "intent-1",
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenCalledTimes(4);
  });

  it("recovers a committed result even when the one retry also loses its response", async () => {
    const complete = vi.fn().mockRejectedValue(new ApiError(0, "NETWORK_ERROR", "Disconnected"));
    const status = vi
      .fn()
      .mockResolvedValueOnce({ intent: { id: "intent-1", status: "pending" } })
      .mockResolvedValueOnce({ intent: { id: "intent-1", status: "pending" } })
      .mockResolvedValue({ intent: { id: "intent-1", status: "completed" }, draft, version });
    await expect(completeWithRecovery("intent-1", complete, status, pause)).resolves.toEqual({
      draft,
      version,
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("does not retry definitive validation failures or exceed Retry-After", async () => {
    for (const failure of [
      new ApiError(400, "INVALID_MEDIA", "Invalid"),
      new ApiError(429, "RATE_LIMITED", "Wait", undefined, "120"),
    ]) {
      const complete = vi.fn().mockRejectedValue(failure);
      const status = vi.fn().mockResolvedValue({ intent: { id: "intent-1", status: "pending" } });
      await expect(completeWithRecovery("intent-1", complete, status, pause)).rejects.toMatchObject(
        { code: "UPLOAD_COMPLETION_UNCERTAIN" },
      );
      expect(complete).toHaveBeenCalledOnce();
    }
  });

  it("stops reconciliation when the reservation expired", async () => {
    const expired = new ApiError(410, "UPLOAD_INTENT_EXPIRED", "Expired");
    const status = vi.fn().mockRejectedValue(expired);
    await expect(
      completeWithRecovery(
        "intent-1",
        async () => {
          throw new Error("Lost");
        },
        status,
        pause,
      ),
    ).rejects.toBe(expired);
    expect(status).toHaveBeenCalledOnce();
  });

  it("keeps authoritative terminal errors", async () => {
    const error = new ApiError(400, "INVALID_MEDIA", "Invalid media");
    await expect(
      completeWithRecovery(
        "intent-1",
        async () => {
          throw error;
        },
        async () => ({ intent: { id: "intent-1", status: "failed" } }),
        pause,
      ),
    ).rejects.toBe(error);
  });
});
