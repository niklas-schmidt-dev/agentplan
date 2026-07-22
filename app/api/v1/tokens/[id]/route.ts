import { authenticateSession } from "@/lib/api/auth";
import { notFound, unauthorized } from "@/lib/api/responses";
import { revokeToken } from "@/lib/tokens/service";
import { uuidSchema } from "@/lib/validation/api";

export const runtime = "nodejs";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await authenticateSession(req);
  if (!session) return unauthorized();

  const id = uuidSchema.safeParse((await params).id);
  if (!id.success) return notFound();

  const revoked = await revokeToken(session.userId, id.data);
  if (!revoked) return notFound();
  return new Response(null, { status: 204 });
}
