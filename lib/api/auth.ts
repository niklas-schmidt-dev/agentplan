import { getAuth } from "@/lib/auth/auth";
import { authenticateBearer } from "@/lib/tokens/service";
import type { TokenScope } from "@/lib/tokens/token";

export type ApiActor =
  | { kind: "session"; userId: string }
  | { kind: "token"; userId: string; tokenId: string; scopes: string[] };

export type ApiAuthFailure = { failure: "unauthorized" } | { failure: "scope"; scope: TokenScope };

/**
 * API requests authenticate with a bearer token (scope-checked) or a browser
 * session (full access for the signed-in user). All decisions are server-side.
 */
export async function authenticateApiRequest(
  req: Request,
  requiredScope: TokenScope,
): Promise<ApiActor | ApiAuthFailure> {
  const authorization = req.headers.get("authorization");
  if (authorization) {
    const bearer = await authenticateBearer(authorization);
    if (!bearer) return { failure: "unauthorized" };
    if (!bearer.scopes.includes(requiredScope)) return { failure: "scope", scope: requiredScope };
    return { kind: "token", ...bearer };
  }

  const session = await getAuth().api.getSession({ headers: req.headers });
  if (!session?.user) return { failure: "unauthorized" };
  return { kind: "session", userId: session.user.id };
}

/** Session-only authentication — used for token management endpoints. */
export async function authenticateSession(req: Request): Promise<{ userId: string } | null> {
  const session = await getAuth().api.getSession({ headers: req.headers });
  return session?.user ? { userId: session.user.id } : null;
}

export function isFailure(actor: ApiActor | ApiAuthFailure): actor is ApiAuthFailure {
  return "failure" in actor;
}
