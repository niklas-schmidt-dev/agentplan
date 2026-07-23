import { internalError, unauthorized } from "@/lib/api/responses";
import { purgePendingUserDeletionObjects } from "@/lib/admin/service";
import { purgeExpiredAuditEvents } from "@/lib/audit/events";
import { purgeDeletedDrafts, purgeExpiredRateLimits } from "@/lib/drafts/purge";
import { constantTimeEqual } from "@/lib/security/compare";
import { purgeRetiredTokens } from "@/lib/tokens/service";

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
    const [drafts, users, tokens] = await Promise.all([
      purgeDeletedDrafts(),
      purgePendingUserDeletionObjects(),
      purgeRetiredTokens(),
    ]);
    await purgeExpiredRateLimits();
    const auditEvents = await purgeExpiredAuditEvents();
    return Response.json({
      purged: drafts.purged,
      failed: drafts.failed,
      userDeletionsPurged: users.purged,
      userDeletionsFailed: users.failed,
      retiredTokensPurged: tokens,
      auditEventsPurged: auditEvents,
    });
  } catch (error) {
    console.error("GET /api/cron/purge failed", error);
    return internalError();
  }
}
