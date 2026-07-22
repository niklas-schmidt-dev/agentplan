import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";

function createAuth() {
  return betterAuth({
    appName: "AgentPlan",
    baseURL: process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL,
    database: drizzleAdapter(getDb(), { provider: "pg", usePlural: true, schema }),
    // Test-only escape hatch so integration/e2e tests can create real
    // sessions without GitHub OAuth. Never enabled in production builds.
    emailAndPassword: {
      enabled: process.env.E2E_AUTH === "1" && process.env.NODE_ENV !== "production",
    },
    socialProviders: {
      github: {
        clientId: process.env.GITHUB_CLIENT_ID ?? "",
        clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
      },
    },
    plugins: [nextCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

let cachedAuth: Auth | undefined;

// Lazy singleton: constructing the auth instance requires DATABASE_URL and the
// auth secrets, which must not be needed at build time.
export function getAuth(): Auth {
  cachedAuth ??= createAuth();
  return cachedAuth;
}
