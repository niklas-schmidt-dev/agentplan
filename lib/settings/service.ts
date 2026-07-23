import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { appSettings } from "@/db/schema";

const SIGNUPS_ENABLED_KEY = "signups_enabled";

/** Missing row = enabled: the row only exists once an admin flips the toggle. */
export async function getSignupsEnabled(): Promise<boolean> {
  const [row] = await getDb()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, SIGNUPS_ENABLED_KEY));
  return row ? row.value === true : true;
}

export async function setSignupsEnabled(enabled: boolean): Promise<void> {
  await getDb()
    .insert(appSettings)
    .values({ key: SIGNUPS_ENABLED_KEY, value: enabled })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: enabled, updatedAt: sql`now()` },
    });
}
