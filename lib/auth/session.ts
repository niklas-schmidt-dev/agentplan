import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getAuth, type Auth } from "./auth";

type SessionResult = Awaited<ReturnType<Auth["api"]["getSession"]>>;
export type SessionUser = NonNullable<SessionResult>["user"];

export const getOptionalUser = cache(async (): Promise<SessionUser | null> => {
  // Touch the dynamic API before constructing auth: this opts the route out of
  // static prerendering, so builds never need DATABASE_URL or auth secrets.
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  return session?.user ?? null;
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
  if (!isAdmin(user)) {
    redirect("/dashboard");
  }
  return user;
}
