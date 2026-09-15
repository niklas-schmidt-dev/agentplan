import { internalError, invalidRequest, notFound } from "@/lib/api/responses";
import { InvalidGroupCursorError } from "@/lib/api/group-cursor";
import { GroupNotFoundError, InvalidGroupError } from "./errors";

export function groupErrorResponse(error: unknown): Response {
  if (error instanceof GroupNotFoundError) return notFound();
  if (error instanceof InvalidGroupError || error instanceof InvalidGroupCursorError)
    return invalidRequest(error.message);
  console.error("Group operation failed", {
    errorType: error instanceof Error ? error.name : "unknown",
  });
  return internalError();
}
