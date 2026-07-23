import { authenticateSession } from "@/lib/api/auth";
import {
  internalError,
  invalidRequest,
  limitErrorResponse,
  unauthorized,
} from "@/lib/api/responses";
import { serializeToken } from "@/lib/api/serialize";
import { createToken, listTokensForUser } from "@/lib/tokens/service";
import { createTokenSchema } from "@/lib/validation/api";

export const runtime = "nodejs";

// Token management is deliberately session-only: an API token must never be
// able to mint or enumerate tokens.

export async function GET(req: Request): Promise<Response> {
  const session = await authenticateSession(req);
  if (!session) return unauthorized();
  const tokens = await listTokensForUser(session.userId);
  return Response.json({ tokens: tokens.map(serializeToken) });
}

export async function POST(req: Request): Promise<Response> {
  const session = await authenticateSession(req);
  if (!session) return unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return invalidRequest("Expected a JSON body.");
  }
  const parsed = createTokenSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error.issues[0]?.message ?? "Invalid body.");
  }

  try {
    const expiresAt = parsed.data.expiresInDays
      ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000)
      : undefined;
    const created = await createToken({
      userId: session.userId,
      name: parsed.data.name,
      scopes: parsed.data.scopes,
      expiresAt,
    });
    // `secret` is the only time the full token is ever returned.
    return Response.json(
      { token: serializeToken(created.record), secret: created.token },
      { status: 201 },
    );
  } catch (error) {
    const limited = limitErrorResponse(error);
    if (limited) return limited;
    console.error("POST /api/v1/tokens failed", error);
    return internalError();
  }
}
