import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordRequestError,
  recordUploadResource,
  withRequestDiagnostics,
  withDiagnosticStage,
} from "@/lib/diagnostics/request";

const intentId = "d141072a-37f6-4f2b-8dc4-d0f00fe5b8e8";
const fileId = "e65c683a-8c71-4bcb-b9aa-f8eb4c389c93";

describe("request diagnostics", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("correlates a successful body upload without logging its signed URL or headers", async () => {
    const route = withRequestDiagnostics(
      "/api/v1/uploads/bundles/[id]/files/[fileId]/body",
      async () => new Response(null, { status: 204 }),
    );
    const response = await route(
      new Request(
        `http://localhost/api/v1/uploads/bundles/${intentId}/files/${fileId}/body?token=secret-token`,
        {
          method: "PUT",
          headers: { authorization: "Bearer secret-auth", "x-request-id": "spoofed" },
          body: "secret-body",
        },
      ),
    );
    const raw = vi.mocked(console.info).mock.calls[0]![0] as string;
    expect(JSON.parse(raw)).toMatchObject({
      event: "request_complete",
      route: "/api/v1/uploads/bundles/[id]/files/[fileId]/body",
      method: "PUT",
      status: 204,
      uploadIntentId: intentId,
      fileId,
      requestId: response.headers.get("x-request-id"),
      durationMs: expect.any(Number),
      timestamp: expect.any(String),
    });
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(raw).not.toMatch(/secret|spoofed|localhost|authorization/);
    expect(console.info).toHaveBeenCalledTimes(1);
  });

  it("returns the public error envelope with an actionable safe error code", async () => {
    const handler = withRequestDiagnostics("/api/v1/uploads/intents", async () => {
      throw Object.assign(new Error("postgres://user:development-only@private-host/db"), {
        code: "ECONNREFUSED",
        query: "private sql",
        detail: "secret detail",
      });
    });
    const response = await handler(new Request("http://localhost/api/v1/uploads/intents"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Something went wrong." },
    });
    const raw = vi.mocked(console.error).mock.calls[0]![0] as string;
    expect(JSON.parse(raw)).toMatchObject({
      requestId: response.headers.get("x-request-id"),
      errorType: "Error",
      errorCode: "ECONNREFUSED",
      status: 500,
    });
    expect(raw).not.toMatch(/password|private|secret|postgres/);
  });

  it("logs handled rejections once and excludes arbitrary error names, codes and identifiers", async () => {
    class SecretCredential extends Error {}
    const handler = withRequestDiagnostics("/api/v1/uploads/intents/[id]", async () => {
      recordUploadResource("uploadIntentId", "secret-filename.html");
      recordRequestError(Object.assign(new SecretCredential("secret"), { code: "secret-code" }));
      return Response.json(
        { error: { code: "INVALID_REQUEST", message: "Expected JSON." } },
        { status: 400 },
      );
    });
    const response = await handler(
      new Request("http://localhost/api/v1/uploads/intents/secret-path"),
    );
    expect(response.status).toBe(400);
    const raw = vi.mocked(console.warn).mock.calls[0]![0] as string;
    expect(JSON.parse(raw)).toMatchObject({ errorType: "Error", status: 400 });
    expect(JSON.parse(raw)).not.toHaveProperty("errorCode");
    expect(JSON.parse(raw)).not.toHaveProperty("uploadIntentId");
    expect(raw).not.toMatch(/secret/i);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("keeps concurrent request identifiers and errors separate", async () => {
    let releaseFirst!: () => void;
    const firstWaiting = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withRequestDiagnostics("/first", async () => {
      recordUploadResource("uploadIntentId", intentId);
      await firstWaiting;
      recordRequestError(new TypeError("private"));
      return new Response(null, { status: 400 });
    });
    const second = withRequestDiagnostics("/second", async () => {
      recordUploadResource("uploadIntentId", fileId);
      return new Response(null, { status: 204 });
    });
    const pending = first(new Request("http://localhost/first"));
    const secondResponse = await second(new Request("http://localhost/second"));
    releaseFirst();
    const firstResponse = await pending;
    const firstLog = JSON.parse(vi.mocked(console.warn).mock.calls[0]![0] as string);
    const secondLog = JSON.parse(vi.mocked(console.info).mock.calls[0]![0] as string);
    expect(firstLog).toMatchObject({
      requestId: firstResponse.headers.get("x-request-id"),
      uploadIntentId: intentId,
      errorType: "TypeError",
    });
    expect(secondLog).toMatchObject({
      requestId: secondResponse.headers.get("x-request-id"),
      uploadIntentId: fileId,
    });
    expect(secondLog).not.toHaveProperty("errorType");
    expect(firstLog.requestId).not.toBe(secondLog.requestId);
  });

  it("explains a wrapped database failure without logging SQL, parameters or credentials", async () => {
    const cause = Object.assign(new Error('column "private-column" does not exist'), {
      code: "42703",
      detail: "private@example.test",
      query: "secret sql",
    });
    const error = new Error("Failed query: secret sql; params: secret-token", { cause });
    const handler = withRequestDiagnostics("/complete", async () =>
      withDiagnosticStage("completion.persist", async () => {
        throw error;
      }),
    );
    const response = await handler(new Request("http://localhost/complete"));
    const raw = vi.mocked(console.error).mock.calls[0]![0] as string;
    expect(JSON.parse(raw)).toMatchObject({
      errorStage: "completion.persist",
      errorCode: "42703",
      errorSummary: "Database column is missing.",
      errorCauses: [expect.objectContaining({ code: "42703" })],
    });
    expect(response.status).toBe(500);
    expect(raw).not.toMatch(/secret|private|params|Failed query/);
    expect(await response.text()).not.toMatch(/42703|Database|completion/);
  });

  it("retains a provider's name and HTTP status through an unknown wrapper", async () => {
    const cause = Object.assign(new Error("signed-url?token=secret"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403, requestId: "secret" },
    });
    const handler = withRequestDiagnostics("/complete", async () => {
      throw new Error("secret wrapper", { cause });
    });
    await handler(new Request("http://localhost/complete"));
    const raw = vi.mocked(console.error).mock.calls[0]![0] as string;
    expect(JSON.parse(raw)).toMatchObject({
      errorCode: "AccessDenied",
      errorSummary: "Storage access was denied.",
      errorCauses: [expect.objectContaining({ type: "AccessDenied", httpStatus: 403 })],
    });
    expect(raw).not.toMatch(/secret|signed-url/);
  });

  it("identifies an unknown failure's operation and UUID across parallel assets and cleanup", async () => {
    const handler = withRequestDiagnostics("/complete", async () => {
      let failure: unknown;
      await Promise.all([
        withDiagnosticStage(
          "storage.head",
          async () => {
            await Promise.resolve();
            throw new Error("unrecognised decoder output secret-filename.png");
          },
          fileId,
        ).catch((error) => {
          failure = error;
        }),
        withDiagnosticStage("media.validate", async () => {}, intentId),
      ]);
      await withDiagnosticStage("completion.release", async () => {});
      throw failure;
    });
    await handler(new Request("http://localhost/complete"));
    const raw = vi.mocked(console.error).mock.calls[0]![0] as string;
    expect(JSON.parse(raw)).toMatchObject({
      errorStage: "storage.head",
      errorFileId: fileId,
      errorSummary: "Could not read stored file metadata; the error has no recognized safe reason.",
    });
    expect(raw).not.toMatch(/secret|decoder|filename/);
  });

  it("bounds cyclic causes and ignores hostile getters and untrusted metadata", async () => {
    const error = Object.assign(new Error("secret"), { name: "secret-name", statusCode: 999 });
    Object.defineProperty(error, "code", {
      get() {
        throw new Error("secret getter");
      },
    });
    error.cause = error;
    const handler = withRequestDiagnostics("/complete", async () => {
      return withDiagnosticStage(
        "storage.open",
        async () => {
          throw error;
        },
        "secret-id",
      );
    });
    const response = await handler(new Request("http://localhost/complete"));
    expect(response.status).toBe(500);
    const raw = vi.mocked(console.error).mock.calls[0]![0] as string;
    expect(raw).not.toMatch(/secret|999/);
    expect(JSON.parse(raw)).not.toHaveProperty("errorFileId");
    expect(JSON.parse(raw)).not.toHaveProperty("errorCauses");
  });

  it.each(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"])(
    "explains %s without exposing module paths or import details",
    async (code) => {
      const handler = withRequestDiagnostics("/complete", async () =>
        withDiagnosticStage("media.validate", async () => {
          throw Object.assign(
            new Error("Cannot find module /private/customer/secret.jpg imported from /private/app"),
            {
              code,
              path: "/private/customer/secret.jpg",
              requireStack: ["/private/app"],
            },
          );
        }),
      );
      const response = await handler(new Request("http://localhost/complete"));
      const raw = vi.mocked(console.error).mock.calls[0]![0] as string;
      expect(JSON.parse(raw)).toMatchObject({
        errorStage: "media.validate",
        errorCode: code,
        errorSummary: "A required server module is missing from the deployment.",
        status: 500,
      });
      expect(raw).not.toMatch(/private|customer|secret|requireStack/);
      expect(await response.json()).toEqual({
        error: { code: "INTERNAL_ERROR", message: "Something went wrong." },
      });
    },
  );
});
