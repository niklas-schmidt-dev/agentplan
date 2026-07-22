import { listDraftsForOwner } from "@/db/queries/drafts";
import { authenticateApiRequest, isFailure } from "@/lib/api/auth";
import { insufficientScope, internalError, invalidRequest, unauthorized } from "@/lib/api/responses";
import { serializeDraft } from "@/lib/api/serialize";
import { readUpload } from "@/lib/api/upload";
import { createDraftWithFirstVersion } from "@/lib/drafts/service";
import { listDraftsQuerySchema } from "@/lib/validation/api";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:write");
  if (isFailure(actor)) {
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  }

  const upload = await readUpload(req);
  if (upload instanceof Response) return upload;

  try {
    const { draft, version } = await createDraftWithFirstVersion({
      ownerId: actor.userId,
      title: upload.title,
      visibility: upload.visibility ?? "private",
      bytes: upload.bytes,
      source: actor.kind === "token" ? "api_token" : "browser",
      tokenId: actor.kind === "token" ? actor.tokenId : undefined,
    });
    return Response.json({ draft: serializeDraft(draft, version.versionNumber) }, { status: 201 });
  } catch (error) {
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
