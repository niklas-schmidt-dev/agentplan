import { getDb } from "@/db/client";
import { uploadIntents } from "@/db/schema";
import { apiError, notFound } from "@/lib/api/responses";
import { getStorage, resolveStorageDriver } from "@/lib/storage";
import { verifyUploadIntentToken } from "@/lib/uploads/tokens";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

export async function PUT(req: Request, { params }: Params): Promise<Response> {
  if (process.env.NODE_ENV === "production" || resolveStorageDriver() !== "fs") {
    return notFound();
  }
  const id = (await params).id;
  const token = verifyUploadIntentToken(new URL(req.url).searchParams.get("token") ?? "");
  if (!token || token.intentId !== id || token.provider !== "fs") return notFound();
  const [intent] = await getDb()
    .select()
    .from(uploadIntents)
    .where(eq(uploadIntents.id, id))
    .limit(1);
  if (
    !intent ||
    intent.status !== "pending" ||
    intent.ownerId !== token.ownerId ||
    intent.stagingKey !== token.stagingKey
  ) {
    return notFound();
  }
  if (req.headers.get("content-type")?.split(";")[0]?.trim() !== intent.contentType) {
    return apiError(400, "INVALID_FILE_TYPE", "Upload content type does not match.");
  }
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared !== intent.expectedBytes) {
    return apiError(400, "SIZE_MISMATCH", "Upload size does not match the reservation.");
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength !== intent.expectedBytes) {
    return apiError(400, "SIZE_MISMATCH", "Upload size does not match the reservation.");
  }
  await getStorage().put(intent.stagingKey, bytes, intent.contentType);
  return new Response(null, { status: 204 });
}
