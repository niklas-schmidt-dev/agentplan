import { getBundleForOwner } from "@/lib/uploads/bundles";
import { apiError, notFound } from "@/lib/api/responses";
import { getStorage, resolveStorageDriver } from "@/lib/storage";
import { verifyUploadIntentToken } from "@/lib/uploads/tokens";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ id: string; fileId: string }> };

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EEXIST"
  );
}

export async function PUT(req: Request, { params }: Params): Promise<Response> {
  if (process.env.NODE_ENV === "production" || resolveStorageDriver() !== "fs") {
    return notFound();
  }
  const { id, fileId } = await params;
  const token = verifyUploadIntentToken(new URL(req.url).searchParams.get("token") ?? "");
  if (!token || token.intentId !== id || token.provider !== "fs") return notFound();
  const bundle = await getBundleForOwner(token.ownerId, id);
  if (
    !bundle ||
    bundle.intent.status !== "pending" ||
    bundle.intent.expiresAt.getTime() <= Date.now()
  ) {
    return notFound();
  }
  const file =
    fileId === bundle.intent.id
      ? {
          finalKey: bundle.intent.finalKey,
          contentType: bundle.intent.contentType,
          expectedBytes:
            bundle.intent.expectedBytes -
            bundle.files.reduce((total, asset) => total + asset.expectedBytes, 0),
        }
      : bundle.files.find((candidate) => candidate.id === fileId);
  if (!file || file.finalKey !== token.stagingKey) return notFound();
  if (req.headers.get("content-type")?.split(";")[0]?.trim() !== file.contentType) {
    return apiError(400, "INVALID_FILE_TYPE", "Upload content type does not match.");
  }
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared !== file.expectedBytes) {
    return apiError(400, "SIZE_MISMATCH", "Upload size does not match the reservation.");
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength !== file.expectedBytes) {
    return apiError(400, "SIZE_MISMATCH", "Upload size does not match the reservation.");
  }
  try {
    await getStorage().putIfAbsent(file.finalKey, bytes, file.contentType);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await getStorage().head(file.finalKey);
    if (existing?.size !== file.expectedBytes) {
      return apiError(409, "UPLOAD_INTENT_CONFLICT", "An immutable upload key already exists.");
    }
  }
  return new Response(null, { status: 204 });
}
