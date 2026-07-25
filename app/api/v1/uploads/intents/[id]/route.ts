import { authenticateApiRequest, isFailure } from "@/lib/api/auth";
import { apiError, insufficientScope, notFound, unauthorized } from "@/lib/api/responses";
import { serializeDraft, serializeVersion } from "@/lib/api/serialize";
import { cancelUploadIntent, getUploadIntentForOwner } from "@/lib/uploads/service";
import { uploadErrorResponse } from "@/lib/uploads/responses";
import { uuidSchema } from "@/lib/validation/api";
import { getDb } from "@/db/client";
import { drafts, draftVersions } from "@/db/schema";
import { eq } from "drizzle-orm";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:write");
  if (isFailure(actor)) {
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  }
  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) return notFound();
  const intent = await getUploadIntentForOwner(actor.userId, id.data);
  if (!intent) return notFound();
  if (
    intent.failureCode === "EXPIRED" ||
    (intent.status === "pending" && intent.expiresAt.getTime() <= Date.now())
  ) {
    return apiError(410, "UPLOAD_INTENT_EXPIRED", "The upload reservation has expired.");
  }
  let result: Record<string, unknown> = {};
  if (intent.status === "completed") {
    const [[draft], [version]] = await Promise.all([
      getDb().select().from(drafts).where(eq(drafts.id, intent.draftId)).limit(1),
      getDb().select().from(draftVersions).where(eq(draftVersions.id, intent.versionId)).limit(1),
    ]);
    if (draft && version) {
      result = {
        draft: serializeDraft(draft, version.versionNumber),
        version: serializeVersion(version),
      };
    }
  }
  return Response.json({
    intent: {
      id: intent.id,
      status: intent.status,
      filename: intent.originalFilename,
      kind: intent.kind,
      reservedBytes: intent.expectedBytes,
      expiresAt: intent.expiresAt.toISOString(),
      failureCode: intent.failureCode,
    },
    ...result,
  });
}

export async function DELETE(req: Request, { params }: Params): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:write");
  if (isFailure(actor)) {
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  }
  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) return notFound();
  try {
    const intent = await getUploadIntentForOwner(actor.userId, id.data);
    if (!intent) return notFound();
    if (
      intent.failureCode === "EXPIRED" ||
      (intent.status === "pending" && intent.expiresAt.getTime() <= Date.now())
    ) {
      return apiError(410, "UPLOAD_INTENT_EXPIRED", "The upload reservation has expired.");
    }
    await cancelUploadIntent(actor.userId, id.data);
    return new Response(null, { status: 204 });
  } catch (error) {
    return uploadErrorResponse(error);
  }
}
