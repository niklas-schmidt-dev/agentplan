import { getDraftForOwner, getVersionById } from "@/db/queries/drafts";
import { authenticateApiRequest, isFailure } from "@/lib/api/auth";
import { insufficientScope, internalError, notFound, unauthorized } from "@/lib/api/responses";
import { serializeDraft, serializeVersion } from "@/lib/api/serialize";
import { DraftNotFoundError, restoreVersion } from "@/lib/drafts/service";
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
    const { version: restored, draft: updatedDraft } = await restoreVersion({
      draft,
      version,
      source: actor.kind === "token" ? "api_token" : "browser",
      tokenId: actor.kind === "token" ? actor.tokenId : undefined,
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
    console.error("POST restore failed", error);
    return internalError();
  }
}
