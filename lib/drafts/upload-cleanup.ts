import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { uploadIntentFiles, uploadIntents } from "@/db/schema";
import { finalObjectCleanupDeadline } from "@/lib/uploads/cleanup-deadline";
import { queueStorageDeletion } from "@/lib/storage/cleanup";

/** Caller holds the owner's storage lock and tombstones the draft in this transaction. */
export async function cancelDraftUploads(
  tx: Pick<Database, "select" | "update" | "insert">,
  draftId: string,
) {
  const pending = await tx
    .update(uploadIntents)
    .set({ status: "cancelled", failureCode: "DRAFT_DELETED", updatedAt: sql`now()` })
    .where(and(eq(uploadIntents.targetDraftId, draftId), eq(uploadIntents.status, "pending")))
    .returning();
  const keys: Array<{ storageKey: string; notBefore?: Date }> = [];
  for (const intent of pending) {
    if (intent.mode === "single") {
      if (intent.stagingKey) {
        keys.push({ storageKey: intent.stagingKey, notBefore: intent.expiresAt });
      }
      keys.push({ storageKey: intent.finalKey, notBefore: finalObjectCleanupDeadline(intent) });
    } else {
      const files = await tx
        .select({ finalKey: uploadIntentFiles.finalKey })
        .from(uploadIntentFiles)
        .where(eq(uploadIntentFiles.intentId, intent.id));
      keys.push(
        ...[intent.finalKey, ...files.map((file) => file.finalKey)].map((storageKey) => ({
          storageKey,
          notBefore: finalObjectCleanupDeadline(intent),
        })),
      );
    }
  }
  for (const key of keys) {
    await queueStorageDeletion(
      {
        storageKey: key.storageKey,
        reason: "draft_deleted",
        notBefore: key.notBefore,
      },
      tx,
    );
  }
  return keys;
}
