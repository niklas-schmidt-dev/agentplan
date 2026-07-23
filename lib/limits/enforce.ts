import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { apiTokens, draftVersions, drafts, users, type UserPlan } from "@/db/schema";
import { QuotaExceededError, RateLimitedError } from "./errors";
import { limitsForPlan, passwordAttemptsPerWindow, type EffectiveLimits } from "./plans";
import { consumeRateLimit } from "./rate-limit";

export async function getUserPlan(userId: string): Promise<UserPlan> {
  const [row] = await getDb()
    .select({ plan: users.plan })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.plan ?? "free";
}

/**
 * Gate for every upload (new draft, new version, restore). Quotas are checked
 * before the rate limit so a quota-blocked request doesn't burn rate budget.
 * Returns the effective limits so callers can apply version retention.
 *
 * The count/sum checks are deliberately not serialized with the writes:
 * concurrent uploads can overshoot a quota by at most the in-flight request
 * count, which the (atomic) upload rate limiter caps at uploadsPerTenMinutes.
 * The storage sum also ignores bytes that version retention is about to free —
 * at the cap boundary that can reject a would-be-neutral update; deleting any
 * draft frees quota immediately.
 */
export async function assertUploadAllowed(params: {
  userId: string;
  sizeBytes: number;
  newDraft: boolean;
}): Promise<EffectiveLimits> {
  const db = getDb();
  const limits = limitsForPlan(await getUserPlan(params.userId));

  if (params.newDraft && limits.maxDrafts !== null) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(drafts)
      .where(and(eq(drafts.ownerId, params.userId), isNull(drafts.deletedAt)));
    if ((row?.count ?? 0) >= limits.maxDrafts) {
      throw new QuotaExceededError(
        `Draft limit reached (${limits.maxDrafts}). Delete drafts you no longer need.`,
      );
    }
  }

  if (limits.maxStorageBytes !== null) {
    const [row] = await db
      .select({ total: sql<string>`coalesce(sum(${draftVersions.sizeBytes}), 0)` })
      .from(draftVersions)
      .innerJoin(drafts, eq(draftVersions.draftId, drafts.id))
      .where(and(eq(drafts.ownerId, params.userId), isNull(drafts.deletedAt)));
    if (Number(row?.total ?? 0) + params.sizeBytes > limits.maxStorageBytes) {
      throw new QuotaExceededError(
        `Storage quota reached (${Math.floor(limits.maxStorageBytes / (1024 * 1024))} MiB). Delete drafts to free up space.`,
      );
    }
  }

  for (const window of [
    { limit: limits.uploadsPerTenMinutes, key: `uploads:10m:${params.userId}`, seconds: 600 },
    { limit: limits.uploadsPerDay, key: `uploads:1d:${params.userId}`, seconds: 86_400 },
  ]) {
    if (window.limit === null) continue;
    const result = await consumeRateLimit({
      key: window.key,
      limit: window.limit,
      windowSeconds: window.seconds,
    });
    if (!result.ok) throw new RateLimitedError(result.retryAfterSeconds);
  }

  return limits;
}

/** Callable with a transaction so the count is atomic with the insert. */
export async function assertTokenCreationAllowed(
  userId: string,
  db: Pick<Database, "select"> = getDb(),
): Promise<void> {
  const limits = limitsForPlan(await getUserPlan(userId));
  if (limits.maxActiveTokens === null) return;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.userId, userId),
        isNull(apiTokens.revokedAt),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, sql`now()`)),
      ),
    );
  if ((row?.count ?? 0) >= limits.maxActiveTokens) {
    throw new QuotaExceededError(
      `Active token limit reached (${limits.maxActiveTokens}). Revoke tokens you no longer use.`,
    );
  }
}

/** Brute-force gate for draft passwords, keyed per draft+IP so one abusive
 *  client cannot lock legitimate viewers out. */
export async function checkPasswordAttempt(
  draftId: string,
  ip: string | null,
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  return consumeRateLimit({
    key: `pw:${draftId}:${ip ?? "unknown"}`,
    limit: passwordAttemptsPerWindow(),
    windowSeconds: 15 * 60,
  });
}
