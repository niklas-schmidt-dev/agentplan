import { count } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users, type UserRole } from "@/db/schema";
import { getSignupsEnabled } from "@/lib/settings/service";

export class SignupsDisabledError extends Error {
  constructor() {
    super("Sign-ups are currently disabled.");
    this.name = "SignupsDisabledError";
  }
}

/**
 * Gate + role decision for every new user, whatever the sign-up method (the
 * auth hook runs for email/password and OAuth alike). The very first user
 * becomes the admin and may register even while sign-ups are disabled —
 * otherwise a deployment could lock itself out before anyone can administer it.
 */
export async function evaluateSignup(): Promise<{ role: UserRole }> {
  const [row] = await getDb().select({ value: count() }).from(users);
  if ((row?.value ?? 0) === 0) return { role: "admin" };
  if (!(await getSignupsEnabled())) throw new SignupsDisabledError();
  return { role: "user" };
}
