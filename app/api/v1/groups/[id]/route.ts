import { authenticateApiRequest, isFailure } from "@/lib/api/auth";
import { insufficientScope, invalidRequest, notFound, unauthorized } from "@/lib/api/responses";
import { getGroupForOwner } from "@/db/queries/groups";
import { dissolveGroup, updateGroup } from "@/lib/groups/service";
import { groupErrorResponse } from "@/lib/groups/responses";
import { patchGroupSchema } from "@/lib/validation/groups";
import { uuidSchema } from "@/lib/validation/api";

export const runtime = "nodejs";
type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:read");
  if (isFailure(actor))
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) return notFound();
  try {
    const group = await getGroupForOwner(id.data, actor.userId);
    return group ? Response.json({ group, ancestors: group.path.slice(0, -1) }) : notFound();
  } catch (error) {
    return groupErrorResponse(error);
  }
}

export async function PATCH(req: Request, { params }: Params): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:write");
  if (isFailure(actor))
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) return notFound();
  const parsed = patchGroupSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalidRequest(parsed.error.issues[0]?.message ?? "Invalid group.");
  try {
    await updateGroup(actor, id.data, parsed.data);
    const group = await getGroupForOwner(id.data, actor.userId);
    return group ? Response.json({ group }) : notFound();
  } catch (error) {
    return groupErrorResponse(error);
  }
}

export async function DELETE(req: Request, { params }: Params): Promise<Response> {
  const actor = await authenticateApiRequest(req, "drafts:write");
  if (isFailure(actor))
    return actor.failure === "scope" ? insufficientScope(actor.scope) : unauthorized();
  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) return notFound();
  try {
    await dissolveGroup(actor, id.data);
    return new Response(null, { status: 204 });
  } catch (error) {
    return groupErrorResponse(error);
  }
}
