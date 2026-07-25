import { getDraftForOwner, listVersions } from "@/db/queries/drafts";
import { authenticateApiRequest, isFailure } from "@/lib/api/auth";
import {
  insufficientScope,
  internalError,
  apiError,
  limitErrorResponse,
  notFound,
  unauthorized,
} from "@/lib/api/responses";
import { serializeDraft, serializeVersion } from "@/lib/api/serialize";
import { readUpload } from "@/lib/api/upload";
import {
  addVersionToDraft,
  DraftNotFoundError,
  DraftWriteConflictError,
} from "@/lib/drafts/service";
import { consumeUploadRateLimit } from "@/lib/limits/enforce";
import { uuidSchema } from "@/lib/validation/api";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:write");
  if (isFailure(actor)) {
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  }

  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) return notFound();
  const draft = await getDraftForOwner(id.data, actor.userId);
  if (!draft) return notFound();
  if (draft.kind !== "html") {
    return apiError(
      409,
      "UPLOAD_KIND_MISMATCH",
      `This draft accepts ${draft.kind} versions through the direct-upload API.`,
    );
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
    const { version, draft: updatedDraft } = await addVersionToDraft({
      draft,
      bytes: upload.bytes,
      originalFilename: upload.originalFilename,
      source: actor.kind === "token" ? "api_token" : "browser",
      tokenId: actor.kind === "token" ? actor.tokenId : undefined,
      rateLimitConsumed: true,
    });
    return Response.json(
      {
        draft: serializeDraft(updatedDraft, version.versionNumber),
        version: serializeVersion(version),
      },
      { status: 201 },
    );
  } catch (error) {
    // Draft soft-deleted between the ownership check and the write: it's gone.
    if (error instanceof DraftNotFoundError) return notFound();
    if (error instanceof DraftWriteConflictError) {
      return apiError(409, "DRAFT_WRITE_CONFLICT", error.message);
    }
    const limited = limitErrorResponse(error);
    if (limited) return limited;
    console.error("POST /api/v1/drafts/:id/versions failed", error);
    return internalError();
  }
}

export async function GET(req: Request, { params }: Params): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:read");
  if (isFailure(actor)) {
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  }

  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) return notFound();
  const draft = await getDraftForOwner(id.data, actor.userId);
  if (!draft) return notFound();

  const versions = await listVersions(draft.id);
  return Response.json({ versions: versions.map(serializeVersion) });
}
