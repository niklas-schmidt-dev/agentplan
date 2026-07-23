import { and, inArray, lte, ne, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditEvents } from "@/db/schema";
import { auditRetentionDays } from "@/lib/limits/plans";

export type AuditEventType =
  | "draft.created"
  | "draft.version_created"
  | "draft.version_restored"
  | "draft.visibility_changed"
  | "draft.title_changed"
  | "draft.deleted"
  | "draft.moderated"
  | "draft.purged"
  | "token.created"
  | "token.revoked"
  | "user.plan_changed"
  | "user.role_changed"
  | "user.deletion_pending"
  | "user.deleted"
  | "settings.signups_changed";

/** Best-effort: an audit failure must never fail the user-facing operation. */
export async function recordAuditEvent(event: {
  type: AuditEventType;
  userId?: string | null;
  draftId?: string | null;
  tokenId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await getDb().insert(auditEvents).values({
      eventType: event.type,
      userId: event.userId ?? null,
      draftId: event.draftId ?? null,
      tokenId: event.tokenId ?? null,
      metadata: event.metadata ?? {},
    });
  } catch (error) {
    console.error("Failed to record audit event", event.type, error);
  }
}

/** Applies the documented finite audit-retention window in bounded cron runs. */
export async function purgeExpiredAuditEvents(batchSize = 500): Promise<number> {
  const days = auditRetentionDays();
  const stale = await getDb()
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        ne(auditEvents.eventType, "user.deletion_pending"),
        lte(auditEvents.createdAt, sql`now() - make_interval(days => ${days})`),
      ),
    )
    .limit(Math.min(Math.max(Math.trunc(batchSize), 1), 1_000));
  if (!stale.length) return 0;
  const deleted = await getDb()
    .delete(auditEvents)
    .where(inArray(auditEvents.id, stale.map((row) => row.id)))
    .returning({ id: auditEvents.id });
  return deleted.length;
}
