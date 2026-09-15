import { authenticateApiRequest, isFailure } from "@/lib/api/auth";
import { insufficientScope, invalidRequest, unauthorized } from "@/lib/api/responses";
import { moveDraftsToGroup } from "@/lib/groups/service";
import { groupErrorResponse } from "@/lib/groups/responses";
import { moveDraftsSchema } from "@/lib/validation/groups";

export const runtime = "nodejs";
export async function POST(req: Request): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:write");
  if (isFailure(actor))
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  const parsed = moveDraftsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalidRequest(parsed.error.issues[0]?.message ?? "Invalid move.");
  try {
    return Response.json(await moveDraftsToGroup(actor, parsed.data.draftIds, parsed.data.groupId));
  } catch (error) {
    return groupErrorResponse(error);
  }
}
