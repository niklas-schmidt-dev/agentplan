import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Must be configured before the lazy storage/db/auth singletons are first used.
process.env.STORAGE_DRIVER = "fs";
process.env.STORAGE_FS_ROOT = mkdtempSync(path.join(os.tmpdir(), "agentplan-signup-"));
process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-not-for-production";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";

import { eq, inArray, like } from "drizzle-orm";
import { POST as authPost } from "@/app/api/auth/[...all]/route";
import { closeDb, getDb } from "@/db/client";
import { appSettings, rateLimits, users } from "@/db/schema";
import { getAuth } from "@/lib/auth/auth";
import { checkAuthAccountRateLimit } from "@/lib/auth/rate-limit";
import { setSignupsEnabled } from "@/lib/settings/service";

const hasDb = Boolean(process.env.DATABASE_URL);

const createdEmails: string[] = [];

async function signUp(email: string) {
  createdEmails.push(email);
  return getAuth().api.signUpEmail({
    body: { email, password: "test-password-123", name: "Hook Test" },
    returnHeaders: true,
  });
}

async function verifiedSignIn(email: string) {
  await getDb().update(users).set({ emailVerified: true }).where(eq(users.email, email));
  return getAuth().api.signInEmail({
    body: { email, password: "test-password-123" },
    returnHeaders: true,
  });
}

async function roleOf(email: string): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ role: users.role })
    .from(users)
    .where(eq(users.email, email));
  return row?.role;
}

describe.skipIf(!hasDb)("better-auth signup hook (integration)", () => {
  afterAll(async () => {
    await getDb().delete(appSettings).where(eq(appSettings.key, "signups_enabled"));
    if (createdEmails.length) {
      await getDb().delete(users).where(inArray(users.email, createdEmails));
    }
    await closeDb();
  });

  it("restricts bootstrap and atomically creates exactly one first admin", async () => {
    await getDb().delete(appSettings);
    await getDb().delete(users);
    const first = `hook-${randomUUID()}@example.test`;
    const second = `hook-${randomUUID()}@example.test`;
    process.env.ADMIN_BOOTSTRAP_EMAIL = first;

    const boundaryId = `hook-boundary-${randomUUID()}`;
    await expect(
      getDb().insert(users).values({
        id: boundaryId,
        name: "Unauthorized Bootstrap",
        email: `${boundaryId}@example.test`,
        emailVerified: true,
      }),
    ).rejects.toThrow();
    await expect(signUp(`unauthorized-${randomUUID()}@example.test`)).rejects.toThrow(
      /restricted/i,
    );
    const results = await Promise.allSettled([signUp(first), signUp(second)]);
    expect(results[0]?.status).toBe("fulfilled");
    if (!(await roleOf(second))) await signUp(second);

    const roles = [await roleOf(first), await roleOf(second)];
    expect(roles.filter((role) => role === "admin")).toHaveLength(1);
    expect(roles.filter((role) => role === "user")).toHaveLength(1);
  });

  it("exposes the role on the session user (requireAdmin depends on this)", async () => {
    const email = `hook-${randomUUID()}@example.test`;
    const signup = await signUp(email);
    expect(signup.headers.get("set-cookie") ?? "").not.toContain("session_token");
    const { headers } = await verifiedSignIn(email);
    const setCookie = headers.get("set-cookie") ?? "";
    const cookie = setCookie
      .split(/,(?=[^;]+=)/)
      .map((part) => part.split(";")[0]?.trim())
      .filter(Boolean)
      .join("; ");
    const session = await getAuth().api.getSession({
      headers: new Headers({ cookie }),
    });
    expect(session?.user.email).toBe(email);
    expect(session?.user.role).toBe(await roleOf(email));
  });

  it("returns the same public response for new and duplicate email sign-ups", async () => {
    const email = `hook-${randomUUID()}@example.test`;
    createdEmails.push(email);
    const request = () =>
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          password: "test-password-123",
          name: "Non-enumerating",
        }),
      });

    const first = await authPost(request());
    const second = await authPost(request());
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await first.text()).toBe(await second.text());
    expect(first.headers.get("set-cookie")).toBeNull();
    expect(second.headers.get("set-cookie")).toBeNull();
  });

  it("enforces a shared, email-hashed sign-up budget", async () => {
    const email = `limited-${randomUUID()}@example.test`;
    const request = () =>
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });

    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(checkAuthAccountRateLimit(request())).resolves.toBeNull();
    }
    const limited = await checkAuthAccountRateLimit(request());
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("retry-after")).toMatch(/^\d+$/);

    const keys = await getDb()
      .select({ key: rateLimits.key })
      .from(rateLimits)
      .where(like(rateLimits.key, "auth:%"));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every(({ key }) => !key.includes(email))).toBe(true);
  });

  it("bounds auth JSON before parsing even without Content-Length", async () => {
    const response = await checkAuthAccountRateLimit(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "oversized@example.test",
          padding: "x".repeat(20 * 1024),
        }),
      }),
    );
    expect(response?.status).toBe(413);
  });

  it("blocks the real sign-up endpoint while sign-ups are disabled", async () => {
    const [admin] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "admin"));
    expect(admin).toBeDefined();

    await setSignupsEnabled({ userId: admin!.id }, false);
    const email = `hook-${randomUUID()}@example.test`;
    await expect(signUp(email)).rejects.toThrow(/disabled/i);
    expect(await roleOf(email)).toBeUndefined();

    // Re-enabling lets the same address through.
    await setSignupsEnabled({ userId: admin!.id }, true);
    await signUp(email);
    expect(await roleOf(email)).toBe("user");
  });

  it("enforces disabled signups at the database insert boundary", async () => {
    const [admin] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "admin"));
    expect(admin).toBeDefined();

    await setSignupsEnabled({ userId: admin!.id }, false);
    const id = `hook-boundary-${randomUUID()}`;
    const email = `${id}@example.test`;
    createdEmails.push(email);
    await expect(
      getDb().insert(users).values({ id, name: "Boundary Test", email, emailVerified: true }),
    ).rejects.toThrow();
    expect(await roleOf(email)).toBeUndefined();

    await setSignupsEnabled({ userId: admin!.id }, true);
  });
});
