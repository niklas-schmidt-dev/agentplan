import { internalError, unauthorized } from "@/lib/api/responses";
import { purgePendingUserDeletionObjects } from "@/lib/admin/service";
import { purgeExpiredViewEvents } from "@/lib/analytics/views";
import { purgeExpiredAuditEvents } from "@/lib/audit/events";
import { reconcileSubscriptions } from "@/lib/billing/service";
import { billingErrorSummary } from "@/lib/billing/errors";
import { purgeDeletedDrafts, purgeExpiredRateLimits } from "@/lib/drafts/purge";
import { constantTimeEqual } from "@/lib/security/compare";
import { purgeRetiredTokens } from "@/lib/tokens/service";
import { purgeStorageDeletionJobs } from "@/lib/storage/cleanup";
import { purgeExpiredUploadIntents } from "@/lib/uploads/service";

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
    const deadline = Date.now() + 270_000;
    const [drafts, users, tokens, storage, uploadIntents, auditEvents, viewEvents] =
      await Promise.all([
        purgeDeletedDrafts(100, deadline),
        purgePendingUserDeletionObjects(100, deadline),
        purgeRetiredTokens(),
        purgeStorageDeletionJobs(100, deadline),
        purgeExpiredUploadIntents(deadline),
        purgeExpiredAuditEvents(500, deadline),
        purgeExpiredViewEvents(5_000, deadline),
      ]);
    await purgeExpiredRateLimits();
    // Billing drift is bounded to one day even if a webhook was lost.
    const billing = await reconcileSubscriptions(deadline).catch((error: unknown) => {
      console.error("Billing reconcile failed", billingErrorSummary(error));
      return { checked: 0, changed: 0, skipped: true, failed: true };
    });

    return Response.json({
      billingChecked: billing.checked,
      billingChanged: billing.changed,
      billingSkipped: billing.skipped,
      purged: drafts.purged,
      failed: drafts.failed,
      userDeletionsPurged: users.purged,
      userDeletionsFailed: users.failed,
      retiredTokensPurged: tokens,
      storageObjectsPurged: storage.purged,
      storageObjectsFailed: storage.failed,
      storageObjectsRemaining: storage.remaining,
      storageOldestDueAt: storage.oldestDueAt,
      deadlineReached: Date.now() >= deadline,
      uploadIntentsExpired: uploadIntents,
      auditEventsPurged: auditEvents,
      viewEventsPurged: viewEvents,
    });
  } catch (error) {
    console.error("GET /api/cron/purge failed", error);
    return internalError();
  }
}
