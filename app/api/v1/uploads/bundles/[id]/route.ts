import { authenticateApiRequest, isFailure } from "@/lib/api/auth";
import { apiError, insufficientScope, notFound, unauthorized } from "@/lib/api/responses";
import { serializeDraft, serializeVersion } from "@/lib/api/serialize";
import { getBundleStatus } from "@/lib/uploads/bundles";
import { cancelUploadIntent } from "@/lib/uploads/service";
import { uploadErrorResponse } from "@/lib/uploads/responses";
import { uuidSchema } from "@/lib/validation/api";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:write");
  if (isFailure(actor)) {
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  }
  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) return notFound();
  const result = await getBundleStatus(actor.userId, id.data, true);
  if (!result) return notFound();
  if (
    result.intent.failureCode === "EXPIRED" ||
    (result.intent.status === "pending" && result.intent.expiresAt.getTime() <= Date.now())
  ) {
    return apiError(410, "UPLOAD_INTENT_EXPIRED", "The upload reservation has expired.");
  }
  return Response.json({
    intent: {
      id: result.intent.id,
      status: result.intent.status,
      entryPath: result.intent.entryPath,
      fileCount: result.intent.fileCount,
      reservedBytes: result.intent.expectedBytes,
      expiresAt: result.intent.expiresAt.toISOString(),
      failureCode: result.intent.failureCode,
    },
    files: result.files,
    ...(result.draft && result.version
      ? {
          draft: serializeDraft(result.draft, result.version.versionNumber),
          version: serializeVersion(result.version),
        }
      : {}),
  });
}

export async function DELETE(req: Request, { params }: Params): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:write");
  if (isFailure(actor)) {
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  }
  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) return notFound();
  const result = await getBundleStatus(actor.userId, id.data);
  if (!result) return notFound();
  if (
    result.intent.failureCode === "EXPIRED" ||
    (result.intent.status === "pending" && result.intent.expiresAt.getTime() <= Date.now())
  ) {
    return apiError(410, "UPLOAD_INTENT_EXPIRED", "The upload reservation has expired.");
  }
  try {
    await cancelUploadIntent(actor.userId, id.data);
    return new Response(null, { status: 204 });
  } catch (error) {
    return uploadErrorResponse(error);
  }
}
