import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { appSettings, users } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit/events";

const SIGNUPS_ENABLED_KEY = "signups_enabled";

/** Missing row = enabled: the row only exists once an admin flips the toggle. */
export async function getSignupsEnabled(): Promise<boolean> {
  const [row] = await getDb()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, SIGNUPS_ENABLED_KEY));
  return row ? row.value === true : true;
}

export async function setSignupsEnabled(
  actor: { userId: string },
  enabled: boolean,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('agentplan:admin-membership'))`);
    const [currentActor] = await tx
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, actor.userId));
    if (currentActor?.role !== "admin") {
      throw new Error("Only current admins can change signup settings");
    }

    await tx
      .insert(appSettings)
      .values({ key: SIGNUPS_ENABLED_KEY, value: enabled })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: enabled, updatedAt: sql`now()` },
      });
  });
  await recordAuditEvent({
    type: "settings.signups_changed",
    userId: actor.userId,
    metadata: { enabled },
  });
}
