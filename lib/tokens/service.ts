import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { apiTokens, type ApiToken } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit/events";
import { assertTokenCreationAllowed } from "@/lib/limits/enforce";
import { constantTimeEqual } from "@/lib/security/compare";
import { generateApiToken, hashToken, type TokenScope } from "./token";

export type CreatedToken = {
  /** Shown exactly once; never persisted or logged. */
  token: string;
  record: ApiToken;
};

export async function createToken(params: {
  userId: string;
  name: string;
  scopes: TokenScope[];
  expiresAt?: Date;
}): Promise<CreatedToken> {
  const generated = generateApiToken();
  const record = await getDb().transaction(async (tx) => {
    // Token creation has no rate limiter, so the cap check must be atomic with
    // the insert: the per-user advisory lock serializes concurrent requests
    // that would otherwise all pass the count while below the cap.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('tokens'), hashtext(${params.userId}))`,
    );
    await assertTokenCreationAllowed(params.userId, tx);
    const [inserted] = await tx
      .insert(apiTokens)
      .values({
        userId: params.userId,
        name: params.name,
        tokenPrefix: generated.tokenPrefix,
        tokenHash: generated.tokenHash,
        scopes: params.scopes,
        expiresAt: params.expiresAt ?? null,
      })
      .returning();
    return inserted;
  });
  if (!record) throw new Error("Token insert returned no rows");
  await recordAuditEvent({
    type: "token.created",
    userId: params.userId,
    tokenId: record.id,
    metadata: { name: params.name, scopes: params.scopes },
  });
  return { token: generated.token, record };
}

/** Active = not revoked and not expired. Expired tokens can't authenticate, so
 *  they must not be listed as active (they'd otherwise look usable). */
export async function listTokensForUser(userId: string): Promise<ApiToken[]> {
  return getDb()
    .select()
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.userId, userId),
        isNull(apiTokens.revokedAt),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, sql`now()`)),
      ),
    )
    .orderBy(desc(apiTokens.createdAt));
}

export async function revokeToken(userId: string, tokenId: string): Promise<boolean> {
  const [updated] = await getDb()
    .update(apiTokens)
    .set({ revokedAt: sql`now()` })
    .where(
      and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)),
    )
    .returning({ id: apiTokens.id });
  if (!updated) return false;
  await recordAuditEvent({ type: "token.revoked", userId, tokenId });
  return true;
}

export type BearerActor = {
  userId: string;
  tokenId: string;
  scopes: string[];
};

/** Validates `Authorization: Bearer ap_live_…`. Returns null on any failure. */
export async function authenticateBearer(authorizationHeader: string | null): Promise<BearerActor | null> {
  if (!authorizationHeader?.startsWith("Bearer ")) return null;
  const token = authorizationHeader.slice("Bearer ".length).trim();
  if (!token.startsWith("ap_live_")) return null;

  const candidateHash = hashToken(token);
  const [record] = await getDb()
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, candidateHash))
    .limit(1);

  if (!record) return null;
  if (!constantTimeEqual(record.tokenHash, candidateHash)) return null;
  if (record.revokedAt) return null;
  if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) return null;

  // Best-effort usage tracking; never blocks the request.
  getDb()
    .update(apiTokens)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(apiTokens.id, record.id))
    .catch(() => {});

  return { userId: record.userId, tokenId: record.id, scopes: record.scopes };
}
