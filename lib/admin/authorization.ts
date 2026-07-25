import { and, count, eq, isNull } from "drizzle-orm";
import type { Database } from "@/db/client";
import { users } from "@/db/schema";

type ReadDatabase = Pick<Database, "select">;

export const activeAdminFilter = and(eq(users.role, "admin"), isNull(users.blockedAt));

/** Every admin mutation re-checks live role and block state inside its transaction. */
export async function assertCurrentAdmin(db: ReadDatabase, userId: string): Promise<void> {
  const [actor] = await db
    .select({ role: users.role, blockedAt: users.blockedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (actor?.role !== "admin" || actor.blockedAt) {
    throw new Error("Only current admins who are not blocked can perform this action");
  }
}

export async function countActiveAdmins(db: ReadDatabase): Promise<number> {
  const [row] = await db.select({ value: count() }).from(users).where(activeAdminFilter);
  return row?.value ?? 0;
}
