import { createHmac } from "node:crypto";
import { and, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { apiTokens, draftVersions, drafts, uploadIntents, users, type UserPlan } from "@/db/schema";
import { QuotaExceededError, RateLimitedError } from "./errors";
import { limitsForPlan, passwordAttemptsPerWindow, type EffectiveLimits } from "./plans";
import { consumeRateLimit, consumeRateLimits } from "./rate-limit";

export async function getUserPlan(
  userId: string,
  db: Pick<Database, "select"> = getDb(),
): Promise<UserPlan> {
  const [row] = await db
    .select({ plan: users.plan })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.plan ?? "free";
}

/**
 * Consumes every upload rate-limit window atomically before storage work.
 */
export async function consumeUploadRateLimit(userId: string): Promise<void> {
  const limits = limitsForPlan(await getUserPlan(userId));
  const windows = [
    { limit: limits.uploadsPerTenMinutes, key: `uploads:10m:${userId}`, windowSeconds: 600 },
    { limit: limits.uploadsPerDay, key: `uploads:1d:${userId}`, windowSeconds: 86_400 },
  ].filter(
    (window): window is { limit: number; key: string; windowSeconds: number } =>
      window.limit !== null,
  );
  const result = await consumeRateLimits(windows);
  if (!result.ok) throw new RateLimitedError(result.retryAfterSeconds);
}

/**
 * Serializes a user's quota check with the subsequent draft/version writes.
 * Callers must pass their active transaction so the advisory lock is held
 * through the write. The storage sum intentionally ignores bytes that version
 * retention is about to free, preserving the conservative cap-boundary rule.
 */
export async function lockAndAssertUploadQuota(
  params: {
    userId: string;
    sizeBytes: number;
    newDraft: boolean;
    excludeIntentId?: string;
  },
  db: Pick<Database, "execute" | "select">,
): Promise<EffectiveLimits> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext('upload-quota'), hashtext(${params.userId}))`,
  );
  const limits = limitsForPlan(await getUserPlan(params.userId, db));

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
    const [[row], [reservationRow]] = await Promise.all([
      db
        .select({ total: sql<string>`coalesce(sum(${draftVersions.sizeBytes}), 0)` })
        .from(draftVersions)
        .innerJoin(drafts, eq(draftVersions.draftId, drafts.id))
        .where(and(eq(drafts.ownerId, params.userId), isNull(drafts.deletedAt))),
      db
        .select({ total: sql<string>`coalesce(sum(${uploadIntents.expectedBytes}), 0)` })
        .from(uploadIntents)
        .where(
          and(
            eq(uploadIntents.ownerId, params.userId),
            eq(uploadIntents.status, "pending"),
            gt(uploadIntents.expiresAt, sql`now()`),
            params.excludeIntentId ? ne(uploadIntents.id, params.excludeIntentId) : undefined,
          ),
        ),
    ]);
    const committed = Number(row?.total ?? 0);
    const reserved = Number(reservationRow?.total ?? 0);
    if (committed + reserved + params.sizeBytes > limits.maxStorageBytes) {
      throw new QuotaExceededError(
        `Storage quota reached: ${Math.ceil(committed / (1024 * 1024))} MiB stored, ${Math.ceil(
          reserved / (1024 * 1024),
        )} MiB reserved, and ${Math.ceil(params.sizeBytes / (1024 * 1024))} MiB requested (${Math.floor(
          limits.maxStorageBytes / (1024 * 1024),
        )} MiB limit). Old versions are pruned only after an upload completes; cancel or wait for pending uploads, or delete content.`,
      );
    }
  }

  return limits;
}

export async function getUserStorageUsage(userId: string): Promise<{
  committedBytes: number;
  reservedBytes: number;
}> {
  const db = getDb();
  const [[committed], [reserved]] = await Promise.all([
    db
      .select({ total: sql<string>`coalesce(sum(${draftVersions.sizeBytes}), 0)` })
      .from(draftVersions)
      .innerJoin(drafts, eq(draftVersions.draftId, drafts.id))
      .where(and(eq(drafts.ownerId, userId), isNull(drafts.deletedAt))),
    db
      .select({ total: sql<string>`coalesce(sum(${uploadIntents.expectedBytes}), 0)` })
      .from(uploadIntents)
      .where(
        and(
          eq(uploadIntents.ownerId, userId),
          eq(uploadIntents.status, "pending"),
          gt(uploadIntents.expiresAt, sql`now()`),
        ),
      ),
  ]);
  return {
    committedBytes: Number(committed?.total ?? 0),
    reservedBytes: Number(reserved?.total ?? 0),
  };
}

/** Callable with a transaction so the count is atomic with the insert. */
export async function assertTokenCreationAllowed(
  userId: string,
  db: Pick<Database, "select"> = getDb(),
): Promise<void> {
  const limits = limitsForPlan(await getUserPlan(userId, db));
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

/** Brute-force gate for draft passwords, keyed per draft+hashed client
 * identifier so one abusive client cannot lock legitimate viewers out. */
export async function checkPasswordAttempt(
  draftId: string,
  clientIdentifier: string | null,
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("BETTER_AUTH_SECRET is required for password rate-limit hashing");
  }
  const identifier = clientIdentifier ?? "unknown";
  const bucket = createHmac("sha256", secret ?? "agentplan-development-only")
    .update(identifier)
    .digest("hex");
  return consumeRateLimit({
    key: `pw:${draftId}:${bucket}`,
    // Vercel supplies an IP. The higher defensive fallback avoids letting one
    // malformed proxy request lock every otherwise-unidentified viewer out.
    limit: clientIdentifier ? passwordAttemptsPerWindow() : passwordAttemptsPerWindow() * 10,
    windowSeconds: 15 * 60,
  });
}
