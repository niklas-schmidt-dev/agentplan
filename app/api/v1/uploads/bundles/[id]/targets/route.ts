import { z } from "zod";
import { authenticateApiRequest, isFailure } from "@/lib/api/auth";
import { insufficientScope, invalidRequest, notFound, unauthorized } from "@/lib/api/responses";
import { issueBundleUploadTargets } from "@/lib/uploads/bundles";
import { uploadErrorResponse } from "@/lib/uploads/responses";
import { uuidSchema } from "@/lib/validation/api";

export const runtime = "nodejs";
export const maxDuration = 300;

const targetSchema = z.object({
  fileIds: z.array(z.uuid()).min(1).max(10),
});

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:write");
  if (isFailure(actor)) {
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  }
  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) return notFound();
  let input: z.infer<typeof targetSchema>;
  try {
    const parsed = targetSchema.safeParse(await req.json());
    if (!parsed.success) {
      return invalidRequest(parsed.error.issues[0]?.message ?? "Invalid file IDs.");
    }
    input = parsed.data;
  } catch {
    return invalidRequest("Expected a JSON upload-target request.");
  }
  try {
    const targets = await issueBundleUploadTargets({
      ownerId: actor.userId,
      intentId: id.data,
      fileIds: input.fileIds,
      baseUrl: new URL(req.url).origin,
    });
    return Response.json({ targets });
  } catch (error) {
    return uploadErrorResponse(error);
  }
}
