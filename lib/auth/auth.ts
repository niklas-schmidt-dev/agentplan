import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { sendAuthEmail } from "./email";
import { authRateLimitStorage } from "./rate-limit";
import {
  BootstrapAuthorizationError,
  evaluateSignup,
  SignupsDisabledError,
} from "./signup-policy";

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
      requireEmailVerification: true,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await sendAuthEmail({ kind: "reset_password", to: user.email, name: user.name, url });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, url }) => {
        await sendAuthEmail({ kind: "verify_email", to: user.email, name: user.name, url });
      },
    },
    rateLimit: {
      enabled: true,
      customStorage: authRateLimitStorage,
      // Better Auth's narrow default (3 attempts / 10s / IP) creates a
      // platform-wide lockout risk behind shared proxies. Keep a distributed
      // route/IP ceiling here; lib/auth/rate-limit.ts adds the stricter
      // HMAC-account budgets that stop targeted credential abuse.
      customRules: {
        "/sign-up/email": { window: 60, max: 20 },
        "/sign-in/email": { window: 60, max: 30 },
        "/request-password-reset": { window: 60, max: 30 },
        "/forget-password": { window: 60, max: 30 },
        "/send-verification-email": { window: 60, max: 30 },
      },
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
              const { role } = await evaluateSignup(user.email);
              return { data: { ...user, role } };
            } catch (error) {
              if (error instanceof SignupsDisabledError) {
                throw new APIError("FORBIDDEN", { message: error.message });
              }
              if (error instanceof BootstrapAuthorizationError) {
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
