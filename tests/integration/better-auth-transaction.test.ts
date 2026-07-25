import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { accounts, appSettings, users } from "@/db/schema";

const hasDb = Boolean(process.env.DATABASE_URL);
const cleanupUserIds: string[] = [];

describe.skipIf(!hasDb)("Better Auth transactional account creation (integration)", () => {
  afterAll(async () => {
    await getDb().delete(appSettings).where(eq(appSettings.key, "signups_enabled"));
    for (const id of cleanupUserIds) {
      await getDb().delete(users).where(eq(users.id, id));
    }
    await closeDb();
  });

  it("rolls back the user when the account-create hook fails", async () => {
    // Ensure this is not the bootstrap insert: the first-user trigger requires
    // an explicitly assigned admin and would fail before reaching the hook.
    const seedId = `transaction-seed-${randomUUID()}`;
    cleanupUserIds.push(seedId);
    await getDb()
      .insert(users)
      .values({
        id: seedId,
        name: "Transaction Seed",
        email: `${seedId}@example.test`,
        emailVerified: true,
        role: "admin",
      });

    let attemptedUserId: string | undefined;
    const auth = betterAuth({
      secret: "transaction-characterization-secret-for-tests",
      baseURL: "http://localhost:3000",
      database: drizzleAdapter(getDb(), {
        provider: "pg",
        usePlural: true,
        schema,
        transaction: true,
      }),
      emailAndPassword: {
        enabled: true,
        autoSignIn: false,
      },
      databaseHooks: {
        account: {
          create: {
            before: async (account) => {
              attemptedUserId = account.userId;
              throw new Error("forced account-create failure");
            },
          },
        },
      },
    });

    const email = `transaction-${randomUUID()}@example.test`;
    await expect(
      auth.api.signUpEmail({
        body: {
          email,
          password: "test-password-123",
          name: "Must Roll Back",
        },
      }),
    ).rejects.toThrow();

    const [survivingUser] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    expect(survivingUser).toBeUndefined();
    expect(attemptedUserId).toBeDefined();
    const survivingCredential = await getDb()
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.userId, attemptedUserId!));
    expect(survivingCredential).toHaveLength(0);
  });
});
