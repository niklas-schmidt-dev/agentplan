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

import { count, eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { appSettings, users } from "@/db/schema";
import { getAuth } from "@/lib/auth/auth";
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

async function roleOf(email: string): Promise<string | undefined> {
  const [row] = await getDb().select({ role: users.role }).from(users).where(eq(users.email, email));
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

  it("makes the first user admin and later users regular users", async () => {
    const [row] = await getDb().select({ value: count() }).from(users);
    const wasEmpty = (row?.value ?? 0) === 0;

    const first = `hook-${randomUUID()}@example.test`;
    await signUp(first);
    expect(await roleOf(first)).toBe(wasEmpty ? "admin" : "user");

    const second = `hook-${randomUUID()}@example.test`;
    await signUp(second);
    expect(await roleOf(second)).toBe("user");
  });

  it("exposes the role on the session user (requireAdmin depends on this)", async () => {
    const email = `hook-${randomUUID()}@example.test`;
    const { headers } = await signUp(email);
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

  it("blocks the real sign-up endpoint while sign-ups are disabled", async () => {
    await setSignupsEnabled(false);
    const email = `hook-${randomUUID()}@example.test`;
    await expect(signUp(email)).rejects.toThrow(/disabled/i);
    expect(await roleOf(email)).toBeUndefined();

    // Re-enabling lets the same address through.
    await setSignupsEnabled(true);
    await signUp(email);
    expect(await roleOf(email)).toBe("user");
  });
});
