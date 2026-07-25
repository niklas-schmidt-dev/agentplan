import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { blockedOauthAccounts, userBlocks, users } from "@/db/schema";

export const IDENTITY_BLOCKED_CODE = "IDENTITY_BLOCKED";
export const ACCOUNT_BLOCKED_CODE = "ACCOUNT_BLOCKED";

export class IdentityBlockedError extends Error {
  constructor() {
    super("This identity cannot register.");
    this.name = "IdentityBlockedError";
  }
}

export function normalizeBlockedEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function isEmailIdentityBlocked(email: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: userBlocks.id })
    .from(userBlocks)
    .where(eq(userBlocks.normalizedEmail, normalizeBlockedEmail(email)))
    .limit(1);
  return Boolean(row);
}

export async function isOauthIdentityBlocked(
  providerId: string,
  accountId: string,
): Promise<boolean> {
  if (providerId === "credential") return false;
  const [row] = await getDb()
    .select({ blockId: blockedOauthAccounts.blockId })
    .from(blockedOauthAccounts)
    .where(
      and(
        eq(blockedOauthAccounts.providerId, providerId),
        eq(blockedOauthAccounts.accountId, accountId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function isUserBlocked(userId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNotNull(users.blockedAt)))
    .limit(1);
  return Boolean(row);
}
