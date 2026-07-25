import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { getAuth, type Auth } from "./auth";

type SessionResult = Awaited<ReturnType<Auth["api"]["getSession"]>>;
export type SessionUser = NonNullable<SessionResult>["user"];

export const getOptionalSession = cache(async (): Promise<SessionResult> => {
  // Touch the dynamic API before constructing auth: this opts the route out of
  // static prerendering, so builds never need DATABASE_URL or auth secrets.
  const requestHeaders = await headers();
  return getAuth().api.getSession({ headers: requestHeaders });
});

export const getOptionalUser = cache(async (): Promise<SessionUser | null> => {
  return (await getOptionalSession())?.user ?? null;
});

export async function requireUser(): Promise<SessionUser> {
  const user = await getOptionalUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}

export function isAdmin(user: SessionUser): boolean {
  return user.role === "admin";
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  const [currentUser] = await getDb()
    .select({ role: users.role })
    .from(users)
    .where(and(eq(users.id, user.id), isNull(users.blockedAt)))
    .limit(1);
  if (currentUser?.role !== "admin") {
    redirect("/dashboard");
  }
  // Return a role value sourced from the live database rather than the
  // potentially cached Better Auth session payload.
  return { ...user, role: "admin" };
}
