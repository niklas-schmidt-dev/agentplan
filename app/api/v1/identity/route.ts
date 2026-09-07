import { authenticateBearer } from "@/lib/tokens/service";
import { unauthorized } from "@/lib/api/responses";

export const runtime = "nodejs";

/** Verify publishing-only tokens without disclosing drafts or requiring read scope. */
export async function GET(req: Request): Promise<Response> {
  const actor = await authenticateBearer(req.headers.get("authorization"));
  if (!actor) return unauthorized();
  return Response.json(
    { userId: actor.userId, scopes: actor.scopes },
    {
      headers: { "cache-control": "private, no-store" },
    },
  );
}
