import { getDb } from "@/db/client";
import { auditEvents } from "@/db/schema";

export type AuditEventType =
  | "draft.created"
  | "draft.version_created"
  | "draft.version_restored"
  | "draft.visibility_changed"
  | "draft.title_changed"
  | "draft.deleted"
  | "token.created"
  | "token.revoked";

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
