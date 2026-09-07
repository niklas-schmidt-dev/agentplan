import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { uploadIntents } from "@/db/schema";

// Longer than the completion routes' 300-second execution budget. No database
// connection is held while storage is read. A token fences expired workers.
export async function claimCompletion(intentId: string): Promise<string | null> {
  const token = randomUUID();
  const [claimed] = await getDb()
    .update(uploadIntents)
    .set({
      completionToken: token,
      completionExpiresAt: sql`now() + interval '6 minutes'`,
    })
    .where(
      and(
        eq(uploadIntents.id, intentId),
        eq(uploadIntents.status, "pending"),
        gt(uploadIntents.expiresAt, sql`now()`),
        or(
          isNull(uploadIntents.completionToken),
          sql`${uploadIntents.completionExpiresAt} <= now()`,
        ),
      ),
    )
    .returning({ id: uploadIntents.id });
  return claimed ? token : null;
}

export function ownsCompletion(intentId: string, token: string) {
  return and(
    eq(uploadIntents.id, intentId),
    eq(uploadIntents.status, "pending"),
    eq(uploadIntents.completionToken, token),
    gt(uploadIntents.completionExpiresAt, sql`now()`),
  );
}

export async function releaseCompletion(intentId: string, token: string): Promise<void> {
  await getDb()
    .update(uploadIntents)
    .set({ completionToken: null, completionExpiresAt: null })
    .where(and(eq(uploadIntents.id, intentId), eq(uploadIntents.completionToken, token)));
}
