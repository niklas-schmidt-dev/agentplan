import { getDraftForOwner, listVersions } from "@/db/queries/drafts";
import { authenticateApiRequest, isFailure } from "@/lib/api/auth";
import { insufficientScope, internalError, notFound, unauthorized } from "@/lib/api/responses";
import { serializeDraft, serializeVersion } from "@/lib/api/serialize";
import { readUpload } from "@/lib/api/upload";
import { addVersionToDraft, DraftNotFoundError } from "@/lib/drafts/service";
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

  const upload = await readUpload(req);
  if (upload instanceof Response) return upload;

  try {
    const { version, draft: updatedDraft } = await addVersionToDraft({
      draft,
      bytes: upload.bytes,
      source: actor.kind === "token" ? "api_token" : "browser",
      tokenId: actor.kind === "token" ? actor.tokenId : undefined,
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
