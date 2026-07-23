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

export class BootstrapAuthorizationError extends Error {
  constructor() {
    super("Initial administrator registration is restricted.");
    this.name = "BootstrapAuthorizationError";
  }
}

function bootstrapAdminEmail(): string | null {
  const value = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  return value || null;
}

/**
 * Gate + role decision for every new user, whatever the sign-up method (the
 * auth hook runs for email/password and OAuth alike). A fresh deployment is
 * fail-closed: only the operator-selected ADMIN_BOOTSTRAP_EMAIL may create the
 * first account. The database trigger independently requires this hook to mark
 * that insert as admin, closing direct/default-role and concurrency bypasses.
 */
export async function evaluateSignup(email: string): Promise<{ role: UserRole }> {
  const [row] = await getDb().select({ value: count() }).from(users);
  if ((row?.value ?? 0) === 0) {
    const allowedEmail = bootstrapAdminEmail();
    if (!allowedEmail || email.trim().toLowerCase() !== allowedEmail) {
      throw new BootstrapAuthorizationError();
    }
    return { role: "admin" };
  }
  if (!(await getSignupsEnabled())) throw new SignupsDisabledError();
  return { role: "user" };
}
