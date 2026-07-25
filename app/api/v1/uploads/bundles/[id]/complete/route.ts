import { authenticateApiRequest, isFailure } from "@/lib/api/auth";
import { insufficientScope, notFound, unauthorized } from "@/lib/api/responses";
import { serializeDraft, serializeVersion } from "@/lib/api/serialize";
import { completeBundleUpload } from "@/lib/uploads/bundles";
import { uploadErrorResponse } from "@/lib/uploads/responses";
import { uuidSchema } from "@/lib/validation/api";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:write");
  if (isFailure(actor)) {
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  }
  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) return notFound();
  try {
    const result = await completeBundleUpload(id.data, actor.userId);
    return Response.json({
      intent: {
        id: result.intent.id,
        status: result.intent.status,
        expiresAt: result.intent.expiresAt.toISOString(),
      },
      draft: serializeDraft(result.draft, result.version.versionNumber),
      version: serializeVersion(result.version),
    });
  } catch (error) {
    return uploadErrorResponse(error);
  }
}
