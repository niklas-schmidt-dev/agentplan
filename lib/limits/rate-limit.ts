import { and, eq, lte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { rateLimits } from "@/db/schema";

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * Fixed-window counter in Postgres: one atomic upsert per attempt, so it is
 * correct across serverless instances without extra infrastructure. Rejected
 * attempts still count — hammering a closed window never reopens it early.
 */
export async function consumeRateLimit(params: {
  key: string;
  limit: number;
  windowSeconds: number;
}): Promise<RateLimitResult> {
  const db = getDb();
  const nowMs = Date.now();
  const windowMs = params.windowSeconds * 1000;
  const windowStart = new Date(Math.floor(nowMs / windowMs) * windowMs);
  const expiresAt = new Date(windowStart.getTime() + windowMs);

  // Opportunistic cleanup of this key's finished windows keeps the table small
  // without a separate maintenance job (the purge cron sweeps stragglers).
  await db
    .delete(rateLimits)
    .where(and(eq(rateLimits.key, params.key), lte(rateLimits.expiresAt, new Date(nowMs))));

  const [row] = await db
    .insert(rateLimits)
    .values({ key: params.key, windowStart, count: 1, expiresAt })
    .onConflictDoUpdate({
      target: [rateLimits.key, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count });

  if (!row) throw new Error("Rate limit upsert returned no rows");
  if (row.count > params.limit) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((expiresAt.getTime() - nowMs) / 1000)),
    };
  }
  return { ok: true };
}
