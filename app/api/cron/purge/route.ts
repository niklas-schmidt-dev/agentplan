import { internalError, unauthorized } from "@/lib/api/responses";
import { purgeDeletedDrafts, purgeExpiredRateLimits } from "@/lib/drafts/purge";
import { constantTimeEqual } from "@/lib/security/compare";

export const runtime = "nodejs";
export const maxDuration = 300;

// Vercel Cron invokes this daily with `Authorization: Bearer ${CRON_SECRET}`
// (see vercel.json). Without the secret configured, the route is disabled.
export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const authorization = req.headers.get("authorization") ?? "";
  if (!secret || !constantTimeEqual(authorization, `Bearer ${secret}`)) {
    return unauthorized();
  }

  try {
    const result = await purgeDeletedDrafts();
    await purgeExpiredRateLimits();
    return Response.json(result);
  } catch (error) {
    console.error("GET /api/cron/purge failed", error);
    return internalError();
  }
}
