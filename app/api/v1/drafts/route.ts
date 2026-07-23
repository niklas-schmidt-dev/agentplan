import { listDraftsForOwner } from "@/db/queries/drafts";
import { authenticateApiRequest, isFailure } from "@/lib/api/auth";
import {
  insufficientScope,
  internalError,
  invalidRequest,
  limitErrorResponse,
  unauthorized,
} from "@/lib/api/responses";
import { serializeDraft } from "@/lib/api/serialize";
import { readUpload } from "@/lib/api/upload";
import {
  createDraftWithFirstVersion,
  PasswordRequiredError,
  PasswordVisibilityConflictError,
} from "@/lib/drafts/service";
import { consumeUploadRateLimit } from "@/lib/limits/enforce";
import { listDraftsQuerySchema } from "@/lib/validation/api";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:write");
  if (isFailure(actor)) {
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  }

  try {
    await consumeUploadRateLimit(actor.userId);
  } catch (error) {
    const limited = limitErrorResponse(error);
    if (limited) return limited;
    throw error;
  }
  const upload = await readUpload(req);
  if (upload instanceof Response) return upload;

  try {
    // Supplying a password without an explicit visibility must protect the
    // draft rather than silently creating a private draft and discarding it.
    const visibility = upload.visibility ?? (upload.password ? "password" : "private");
    const { draft, version } = await createDraftWithFirstVersion({
      ownerId: actor.userId,
      title: upload.title,
      visibility,
      password: upload.password,
      bytes: upload.bytes,
      source: actor.kind === "token" ? "api_token" : "browser",
      tokenId: actor.kind === "token" ? actor.tokenId : undefined,
      rateLimitConsumed: true,
    });
    return Response.json({ draft: serializeDraft(draft, version.versionNumber) }, { status: 201 });
  } catch (error) {
    if (error instanceof PasswordRequiredError) {
      return invalidRequest("A password is required for password-protected drafts.");
    }
    if (error instanceof PasswordVisibilityConflictError) {
      return invalidRequest("A password cannot be combined with public or private visibility.");
    }
    const limited = limitErrorResponse(error);
    if (limited) return limited;
    console.error("POST /api/v1/drafts failed", error);
    return internalError();
  }
}

export async function GET(req: Request): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:read");
  if (isFailure(actor)) {
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  }

  const url = new URL(req.url);
  const query = listDraftsQuerySchema.safeParse({
    search: url.searchParams.get("search") ?? undefined,
    visibility: url.searchParams.get("visibility") ?? undefined,
  });
  if (!query.success) {
    return invalidRequest(query.error.issues[0]?.message ?? "Invalid query.");
  }

  const drafts = await listDraftsForOwner(actor.userId, query.data);
  return Response.json({
    drafts: drafts.map((draft) =>
      serializeDraft(draft, draft.currentVersion?.versionNumber ?? null),
    ),
  });
}
