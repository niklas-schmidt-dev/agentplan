import { and, gt, isNull, or, sql } from "drizzle-orm";
import { drafts } from "@/db/schema";
import { validateExpirySeconds } from "@agentplan/upload-contract";

/** Checked on reads and writes, independently of when the cleanup job runs. */
export const liveDraftCondition = and(
  isNull(drafts.deletedAt),
  or(isNull(drafts.expiresAt), gt(drafts.expiresAt, sql`clock_timestamp()`)),
)!;

/** Start the lifetime when the published draft is persisted, after transfer/validation. */
export function draftExpiration(seconds?: number | null) {
  const duration = validateExpirySeconds(seconds);
  return duration === null
    ? null
    : sql<Date>`clock_timestamp() + make_interval(secs => ${duration})`;
}
