import { getDraftForOwner, getVersionById } from "@/db/queries/drafts";
import { authenticateApiRequest, isFailure } from "@/lib/api/auth";
import {
  apiError,
  insufficientScope,
  internalError,
  limitErrorResponse,
  notFound,
  unauthorized,
} from "@/lib/api/responses";
import { serializeDraft, serializeVersion } from "@/lib/api/serialize";
import { DraftNotFoundError, DraftWriteConflictError, restoreVersion } from "@/lib/drafts/service";
import { consumeUploadRateLimit } from "@/lib/limits/enforce";
import { restoreBundleVersion } from "@/lib/uploads/bundles";
import { uuidSchema } from "@/lib/validation/api";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; versionId: string }> };

export async function POST(req: Request, { params }: Params): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:write");
  if (isFailure(actor)) {
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  }

  const raw = await params;
  const id = uuidSchema.safeParse(raw.id);
  const versionId = uuidSchema.safeParse(raw.versionId);
  if (!id.success || !versionId.success) return notFound();

  const draft = await getDraftForOwner(id.data, actor.userId);
  if (!draft) return notFound();
  const version = await getVersionById(draft.id, versionId.data);
  if (!version) return notFound();

  try {
    await consumeUploadRateLimit(actor.userId);
    const source = actor.kind === "token" ? "api_token" : "browser";
    const { version: restored, draft: updatedDraft } = version.isBundle
      ? await restoreBundleVersion({
          ownerId: actor.userId,
          draftId: draft.id,
          sourceVersionId: version.id,
          source,
          tokenId: actor.kind === "token" ? actor.tokenId : undefined,
        })
      : await restoreVersion({
          draft,
          version,
          source,
          tokenId: actor.kind === "token" ? actor.tokenId : undefined,
          rateLimitConsumed: true,
        });
    return Response.json(
      {
        draft: serializeDraft(updatedDraft, restored.versionNumber),
        version: serializeVersion(restored),
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof DraftNotFoundError) return notFound();
    if (error instanceof DraftWriteConflictError) {
      return apiError(409, "DRAFT_WRITE_CONFLICT", error.message);
    }
    const limited = limitErrorResponse(error);
    if (limited) return limited;
    console.error("POST restore failed", error);
    return internalError();
  }
}
