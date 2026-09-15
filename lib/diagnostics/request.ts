import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { internalError } from "@/lib/api/responses";
import { safeErrorDetails } from "./errors";

type RequestDiagnostic = {
  requestId: string;
  route: string;
  method: string;
  uploadIntentId?: string;
  fileId?: string;
  errorStage?: string;
  errorFileId?: string;
  errorSummary?: string;
} & Partial<ReturnType<typeof safeErrorDetails>>;

const requests = new AsyncLocalStorage<RequestDiagnostic>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failedStages = new WeakMap<
  RequestDiagnostic,
  Map<unknown, { stage: DiagnosticStage; fileId?: string }>
>();
const stages = {
  "completion.load": "Could not load the upload reservation",
  "completion.claim": "Could not claim upload completion",
  "storage.head": "Could not read stored file metadata",
  "storage.open": "Could not open the stored file",
  "storage.copy": "Could not copy the uploaded file",
  "media.validate": "Could not validate the uploaded media",
  "entry.validate": "Could not read and verify the HTML entry",
  "verification.persist": "Could not save file verification",
  "completion.persist": "Could not save the draft version",
  "completion.audit": "Could not record the upload audit event",
  "completion.release": "Could not release the upload completion lease",
} as const;
type DiagnosticStage = keyof typeof stages;

/** Fixed operation labels and UUIDs only. Capture at the throw site, before parallel work or cleanup. */
export async function withDiagnosticStage<T>(
  stage: DiagnosticStage,
  operation: () => PromiseLike<T>,
  fileId?: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const context = requests.getStore();
    if (context && Object.hasOwn(stages, stage)) {
      let failures = failedStages.get(context);
      if (!failures) failedStages.set(context, (failures = new Map()));
      // The innermost operation is the most useful. Bound retention for handled errors.
      if (!failures.has(error) && failures.size < 32) {
        failures.set(error, { stage, ...(fileId && uuid.test(fileId) ? { fileId } : {}) });
      }
    }
    throw error;
  }
}

/** Attach identifiers only after validation; never attach filenames, keys or user data. */
export function recordUploadResource(key: "uploadIntentId" | "fileId", value: string): void {
  const context = requests.getStore();
  if (context && uuid.test(value)) context[key] = value;
}

/** Traverse wrapped causes, but emit only fixed descriptions and validated metadata. */
export function recordRequestError(error: unknown): void {
  const context = requests.getStore();
  if (!context) return;
  const failure = failedStages.get(context)?.get(error);
  // Clear optional fields if a handler records a different error later.
  delete context.errorCode;
  delete context.errorCauses;
  delete context.errorHttpStatus;
  delete context.errorStage;
  delete context.errorFileId;
  const details = safeErrorDetails(error);
  Object.assign(context, details, {
    errorSummary:
      details.errorSummary ??
      `${failure ? stages[failure.stage] : "Request failed"}; the error has no recognized safe reason.`,
  });
  if (failure) {
    context.errorStage = failure.stage;
    if (failure.fileId) context.errorFileId = failure.fileId;
  }
}

/** route must be a literal route template, never a request URL or user input. */
export function withRequestDiagnostics<Args extends unknown[]>(
  route: string,
  handler: (request: Request, ...args: Args) => Promise<Response>,
  errorResponse: (error: unknown) => Response = internalError,
): (request: Request, ...args: Args) => Promise<Response> {
  return async (request, ...args) => {
    const startedAt = performance.now();
    const context: RequestDiagnostic = {
      requestId: randomUUID(),
      route,
      method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(request.method)
        ? request.method
        : "OTHER",
    };
    return requests.run(context, async () => {
      // Only copy UUIDs from matching path positions. Query strings, tokens and raw paths
      // are intentionally excluded, including on the local signed body endpoints.
      const template = route.split("/");
      const pathname = new URL(request.url).pathname.split("/");
      if (
        template.length === pathname.length &&
        template.every(
          (part, index) => part === "[id]" || part === "[fileId]" || part === pathname[index],
        )
      ) {
        for (const [index, part] of template.entries()) {
          if (part === "[id]") recordUploadResource("uploadIntentId", pathname[index] ?? "");
          if (part === "[fileId]") recordUploadResource("fileId", pathname[index] ?? "");
        }
      }
      let response: Response;
      try {
        response = await handler(request, ...args);
      } catch (error) {
        recordRequestError(error);
        response = errorResponse(error);
      }
      response.headers.set("x-request-id", context.requestId);
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "request_complete",
        ...context,
        status: response.status,
        durationMs: Math.round(performance.now() - startedAt),
      });
      if (response.status >= 500) console.error(entry);
      else if (response.status >= 400) console.warn(entry);
      else console.info(entry);
      return response;
    });
  };
}
