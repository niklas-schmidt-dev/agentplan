import { drainBatches } from "@/lib/maintenance/drain";
import { createHmac } from "node:crypto";
import { inArray, lte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { draftViewEvents, type DraftViewerKind } from "@/db/schema";
import { viewRetentionDays } from "@/lib/limits/plans";
import { appUrl } from "@/lib/urls";

export function classifyViewer(draft: { ownerId: string }, userId: string | null): DraftViewerKind {
  if (!userId) return "anonymous";
  return userId === draft.ownerId ? "owner" : "user";
}

/**
 * Salted hash identifying one visitor within one UTC day. The daily rotation
 * means the same visitor hashes differently across days, so no long-lived
 * pseudonymous identifier accumulates; unique counts are per-day accurate.
 */
export function visitorHash(
  input: { ip: string | null; userAgent: string | null },
  now: Date = new Date(),
): string | null {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || (!input.ip && !input.userAgent)) return null;
  return createHmac("sha256", secret)
    .update("draft-view-visitor\0")
    .update(now.toISOString().slice(0, 10))
    .update("\0")
    .update(input.ip ?? "")
    .update("\0")
    .update(input.userAgent ?? "")
    .digest("hex");
}

/** Extracts the referrer's host; drops self-referrals and unparsable values. */
export function referrerHost(referer: string | null): string | null {
  if (!referer) return null;
  let host: string;
  try {
    const url = new URL(referer);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    host = url.host.toLowerCase();
  } catch {
    return null;
  }
  try {
    if (host === new URL(appUrl()).host.toLowerCase()) return null;
  } catch {
    // Keep the referrer when our own URL is unknown.
  }
  return host.slice(0, 255);
}

export function normalizeCountry(value: string | null): string | null {
  const country = value?.trim().toUpperCase();
  return country && /^[A-Z]{2}$/.test(country) ? country : null;
}

export type ViewRequestContext = {
  ip: string | null;
  userAgent: string | null;
  referer: string | null;
  country: string | null;
};

export function viewRequestContext(requestHeaders: Headers): ViewRequestContext {
  // First hop of x-forwarded-for is the client; Vercel's proxy sets it.
  const forwarded = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip =
    forwarded ||
    requestHeaders.get("x-real-ip")?.trim() ||
    requestHeaders.get("cf-connecting-ip")?.trim() ||
    null;
  return {
    ip,
    userAgent: requestHeaders.get("user-agent")?.trim() || null,
    referer: requestHeaders.get("referer"),
    country: requestHeaders.get("x-vercel-ip-country"),
  };
}

/** Best-effort: an analytics failure must never fail the user-facing view. */
export async function recordDraftView(event: {
  draftId: string;
  viewer: DraftViewerKind;
  context: ViewRequestContext;
}): Promise<void> {
  try {
    await getDb()
      .insert(draftViewEvents)
      .values({
        draftId: event.draftId,
        viewer: event.viewer,
        visitorHash: visitorHash(event.context),
        country: normalizeCountry(event.context.country),
        referrerHost: referrerHost(event.context.referer),
      });
  } catch (error) {
    console.error("Failed to record draft view", event.draftId, error);
  }
}

/** Applies the finite view-event retention window in bounded cron runs. */
export async function purgeExpiredViewEvents(
  batchSize = 5000,
  deadline = Date.now() + 30_000,
): Promise<number> {
  return drainBatches(() => purgeExpiredViewEventsBatch(batchSize), deadline);
}

async function purgeExpiredViewEventsBatch(batchSize: number): Promise<number> {
  const days = viewRetentionDays();
  const stale = await getDb()
    .select({ id: draftViewEvents.id })
    .from(draftViewEvents)
    .where(lte(draftViewEvents.viewedAt, sql`now() - make_interval(days => ${days})`))
    .limit(Math.min(Math.max(Math.trunc(batchSize), 1), 10_000));
  if (!stale.length) return 0;
  const deleted = await getDb()
    .delete(draftViewEvents)
    .where(
      inArray(
        draftViewEvents.id,
        stale.map((row) => row.id),
      ),
    )
    .returning({ id: draftViewEvents.id });
  return deleted.length;
}
