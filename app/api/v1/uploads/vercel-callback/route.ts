import { handleUploadPresigned, type HandleUploadPresignedBody } from "@vercel/blob/client";
import { internalError } from "@/lib/api/responses";
import { completeUploadIntent } from "@/lib/uploads/service";
import { verifyUploadIntentToken } from "@/lib/uploads/tokens";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as HandleUploadPresignedBody;
    const result = await handleUploadPresigned({
      body,
      request: req,
      getSignedToken: async () => {
        throw new Error("This endpoint only accepts upload-completed callbacks");
      },
      onUploadCompleted: async ({ tokenPayload }) => {
        const token = tokenPayload ? verifyUploadIntentToken(tokenPayload) : null;
        if (!token || token.provider !== "vercel-blob") {
          throw new Error("Invalid upload callback token");
        }
        await completeUploadIntent(token.intentId, token.ownerId);
      },
    });
    return Response.json(result);
  } catch (error) {
    console.error("Vercel Blob upload callback failed", error);
    return internalError();
  }
}
