import { getAuth } from "@/lib/auth/auth";
import { checkAuthAccountRateLimit } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";

async function genericSignupResponse(startedAt: number): Promise<Response> {
  // Equalize the fast duplicate path with normal password hashing/database
  // work so status/body hardening is not undone by an obvious timing oracle.
  const remainingMs = 250 - (performance.now() - startedAt);
  if (remainingMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, remainingMs));
  }
  return Response.json(
    { message: "If this address can be registered, a verification link has been sent." },
    {
      status: 202,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}

async function handler(req: Request): Promise<Response> {
  const startedAt = performance.now();
  const limited = await checkAuthAccountRateLimit(req);
  if (limited) return limited;
  const response = await getAuth().handler(req);
  if (req.method !== "POST" || new URL(req.url).pathname !== "/api/auth/sign-up/email") {
    return response;
  }

  // The browser/API response must not reveal whether an email is already
  // registered. New and duplicate sign-ups therefore have the same status and
  // body; operator policy failures and invalid requests remain explicit.
  if (response.ok) return genericSignupResponse(startedAt);
  try {
    const body = (await response.clone().json()) as { code?: unknown };
    if (typeof body.code === "string" && body.code.includes("USER_ALREADY_EXISTS")) {
      return genericSignupResponse(startedAt);
    }
  } catch {
    // Preserve malformed upstream errors rather than accidentally masking them.
  }
  return response;
}

export { handler as GET, handler as POST };
