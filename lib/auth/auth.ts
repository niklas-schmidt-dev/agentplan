import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { evaluateSignup, SignupsDisabledError } from "./signup-policy";

/** GitHub OAuth is optional: without credentials only email/password is offered. */
export function isGithubConfigured(): boolean {
  return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

function createAuth() {
  const githubClientId = process.env.GITHUB_CLIENT_ID;
  const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;

  return betterAuth({
    appName: "AgentPlan",
    baseURL: process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL,
    database: drizzleAdapter(getDb(), { provider: "pg", usePlural: true, schema }),
    emailAndPassword: {
      enabled: true,
    },
    socialProviders:
      githubClientId && githubClientSecret
        ? { github: { clientId: githubClientId, clientSecret: githubClientSecret } }
        : {},
    user: {
      additionalFields: {
        // input: false keeps role out of the sign-up payload; only the
        // databaseHooks below (and admin actions) can ever set it.
        role: { type: "string", required: false, defaultValue: "user", input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            try {
              const { role } = await evaluateSignup();
              return { data: { ...user, role } };
            } catch (error) {
              if (error instanceof SignupsDisabledError) {
                throw new APIError("FORBIDDEN", { message: error.message });
              }
              throw error;
            }
          },
        },
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
