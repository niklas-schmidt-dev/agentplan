/**
 * Sets a user's plan. "unlimited" bypasses all quotas and upload rate limits.
 *
 *   bun scripts/set-user-plan.ts <email> <free|unlimited>
 *
 * Needs DATABASE_URL (bun loads .env automatically).
 */
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { users } from "../db/schema";

const [email, plan] = process.argv.slice(2);
if (!email || (plan !== "free" && plan !== "unlimited")) {
  console.error("Usage: bun scripts/set-user-plan.ts <email> <free|unlimited>");
  process.exit(1);
}

const [updated] = await getDb()
  .update(users)
  .set({ plan })
  .where(eq(users.email, email))
  .returning({ email: users.email, plan: users.plan });

if (updated) {
  console.log(`${updated.email} → ${updated.plan}`);
} else {
  console.error(`No user found with email ${email}`);
  process.exitCode = 1;
}
await closeDb();
