import { withRequestDiagnostics } from "@/lib/diagnostics/request";
import { uploadErrorResponse } from "./responses";

export function withUploadDiagnostics<Args extends unknown[]>(
  route: string,
  handler: (request: Request, ...args: Args) => Promise<Response>,
): (request: Request, ...args: Args) => Promise<Response> {
  return withRequestDiagnostics(route, handler, uploadErrorResponse);
}
