import { and, eq, lt, lte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { rateLimits } from "@/db/schema";

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

type RateLimitWindow = {
  key: string;
  limit: number;
  windowSeconds: number;
};

class RateLimitBlocked extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Rate limit exceeded");
  }
}

/**
 * Fixed-window counters in Postgres. All supplied windows are consumed in one
 * transaction: if any window is already closed, earlier increments roll back
 * so a rejected daily request cannot burn the shorter-window budget (or vice
 * versa). Conditional upserts keep the decision correct across instances.
 */
export async function consumeRateLimits(windows: RateLimitWindow[]): Promise<RateLimitResult> {
  if (windows.length === 0) return { ok: true };

  const db = getDb();
  const nowMs = Date.now();
  const attempts = windows.map((window) => {
    const windowMs = window.windowSeconds * 1000;
    const windowStart = new Date(Math.floor(nowMs / windowMs) * windowMs);
    return {
      ...window,
      windowStart,
      expiresAt: new Date(windowStart.getTime() + windowMs),
    };
  });

  try {
    await db.transaction(async (tx) => {
      for (const attempt of attempts) {
        // Opportunistic cleanup of this key's finished windows keeps the table
        // small without relying exclusively on the daily sweep.
        await tx
          .delete(rateLimits)
          .where(and(eq(rateLimits.key, attempt.key), lte(rateLimits.expiresAt, new Date(nowMs))));

        const [row] = await tx
          .insert(rateLimits)
          .values({
            key: attempt.key,
            windowStart: attempt.windowStart,
            count: 1,
            expiresAt: attempt.expiresAt,
          })
          .onConflictDoUpdate({
            target: [rateLimits.key, rateLimits.windowStart],
            set: { count: sql`${rateLimits.count} + 1` },
            setWhere: lt(rateLimits.count, attempt.limit),
          })
          .returning({ count: rateLimits.count });

        if (!row) {
          throw new RateLimitBlocked(
            Math.max(1, Math.ceil((attempt.expiresAt.getTime() - nowMs) / 1000)),
          );
        }
      }
    });
  } catch (error) {
    if (error instanceof RateLimitBlocked) {
      return { ok: false, retryAfterSeconds: error.retryAfterSeconds };
    }
    throw error;
  }

  return { ok: true };
}

export async function consumeRateLimit(params: RateLimitWindow): Promise<RateLimitResult> {
  return consumeRateLimits([params]);
}
