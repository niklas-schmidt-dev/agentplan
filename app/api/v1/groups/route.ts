import { authenticateApiRequest, isFailure } from "@/lib/api/auth";
import { insufficientScope, invalidRequest, notFound, unauthorized } from "@/lib/api/responses";
import { getGroupForOwner, listGroupsPageForOwner } from "@/db/queries/groups";
import { createGroup } from "@/lib/groups/service";
import { groupErrorResponse } from "@/lib/groups/responses";
import { createGroupSchema, listGroupsQuerySchema } from "@/lib/validation/groups";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:read");
  if (isFailure(actor))
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  const query = listGroupsQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!query.success) return invalidRequest(query.error.issues[0]?.message ?? "Invalid query.");
  try {
    return Response.json(await listGroupsPageForOwner(actor.userId, query.data));
  } catch (error) {
    return groupErrorResponse(error);
  }
}

export async function POST(req: Request): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:write");
  if (isFailure(actor))
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  const body: unknown = await req.json().catch(() => null);
  const parsed = createGroupSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error.issues[0]?.message ?? "Invalid group.");
  try {
    const created = await createGroup(actor, parsed.data);
    const group = await getGroupForOwner(created.id, actor.userId);
    return group ? Response.json({ group }, { status: 201 }) : notFound();
  } catch (error) {
    return groupErrorResponse(error);
  }
}
