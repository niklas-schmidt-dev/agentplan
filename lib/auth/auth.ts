import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { appUrl } from "@/lib/urls";
import {
  ACCOUNT_BLOCKED_CODE,
  IDENTITY_BLOCKED_CODE,
  IdentityBlockedError,
  isOauthIdentityBlocked,
  isUserBlocked,
} from "./blocked-identities";
import { isEmailDeliveryConfigured, sendAuthEmail } from "./email";
import { authRateLimitStorage } from "./rate-limit";
import { BootstrapAuthorizationError, evaluateSignup, SignupsDisabledError } from "./signup-policy";

/** GitHub OAuth is an optional addition to the baseline email/password login. */
export function isGithubConfigured(): boolean {
  return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

function createAuth() {
  const githubClientId = process.env.GITHUB_CLIENT_ID;
  const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
  const emailDeliveryConfigured = isEmailDeliveryConfigured();

  return betterAuth({
    appName: "AgentPlan",
    baseURL: appUrl(),
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      usePlural: true,
      schema,
      transaction: true,
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: emailDeliveryConfigured,
      autoSignIn: false,
      ...(emailDeliveryConfigured
        ? {
            revokeSessionsOnPasswordReset: true,
            sendResetPassword: async ({
              user,
              url,
            }: {
              user: { email: string; name: string };
              url: string;
            }) => {
              await sendAuthEmail({
                kind: "reset_password",
                to: user.email,
                name: user.name,
                url,
              });
            },
          }
        : {}),
    },
    ...(emailDeliveryConfigured
      ? {
          emailVerification: {
            sendOnSignUp: true,
            sendOnSignIn: true,
            autoSignInAfterVerification: true,
            expiresIn: 60 * 60,
            sendVerificationEmail: async ({
              user,
              url,
            }: {
              user: { email: string; name: string };
              url: string;
            }) => {
              await sendAuthEmail({
                kind: "verify_email",
                to: user.email,
                name: user.name,
                url,
              });
            },
          },
        }
      : {}),
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
              if (error instanceof IdentityBlockedError) {
                throw new APIError("FORBIDDEN", {
                  message: error.message,
                  code: IDENTITY_BLOCKED_CODE,
                });
              }
              throw error;
            }
          },
        },
      },
      account: {
        create: {
          before: async (account) => {
            if (
              (await isUserBlocked(account.userId)) ||
              (await isOauthIdentityBlocked(account.providerId, account.accountId))
            ) {
              throw new APIError("FORBIDDEN", {
                message: "Unable to create this account.",
                code: IDENTITY_BLOCKED_CODE,
              });
            }
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            if (await isUserBlocked(session.userId)) {
              throw new APIError("FORBIDDEN", {
                message: "This account has been blocked.",
                code: ACCOUNT_BLOCKED_CODE,
              });
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
