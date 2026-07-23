import { createHmac } from "node:crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { rateLimits } from "@/db/schema";
import { consumeRateLimit } from "@/lib/limits/rate-limit";

function storageKey(rawKey: string): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required for auth rate limiting");
  return `auth:${createHmac("sha256", secret).update(rawKey).digest("hex")}`;
}

/**
 * Better Auth custom storage backed by AgentPlan's atomic Postgres counters.
 * `consume` is the security path. `get`/`set` implement the legacy interface so
 * an upstream fallback remains shared rather than silently reverting to memory.
 */
export const authRateLimitStorage = {
  async get(rawKey: string) {
    const key = storageKey(rawKey);
    const [row] = await getDb()
      .select({
        count: rateLimits.count,
        windowStart: rateLimits.windowStart,
      })
      .from(rateLimits)
      .where(and(eq(rateLimits.key, key), gt(rateLimits.expiresAt, sql`now()`)))
      .orderBy(desc(rateLimits.windowStart))
      .limit(1);
    return row
      ? { key: rawKey, count: row.count, lastRequest: row.windowStart.getTime() }
      : null;
  },

  async set(
    rawKey: string,
    value: { count: number; lastRequest: number },
    update?: boolean,
  ): Promise<void> {
    const key = storageKey(rawKey);
    const windowStart = new Date(value.lastRequest);
    const expiresAt = new Date(value.lastRequest + 60_000);
    if (update) {
      await getDb()
        .update(rateLimits)
        .set({ count: value.count, expiresAt })
        .where(eq(rateLimits.key, key));
      return;
    }
    await getDb()
      .insert(rateLimits)
      .values({ key, windowStart, count: value.count, expiresAt })
      .onConflictDoUpdate({
        target: [rateLimits.key, rateLimits.windowStart],
        set: { count: value.count, expiresAt },
      });
  },

  async consume(rawKey: string, rule: { window: number; max: number }) {
    const result = await consumeRateLimit({
      key: storageKey(rawKey),
      limit: rule.max,
      windowSeconds: rule.window,
    });
    return result.ok
      ? { allowed: true, retryAfter: null }
      : { allowed: false, retryAfter: result.retryAfterSeconds };
  },
};

type AccountLimit = { limit: number; windowSeconds: number };
const MAX_AUTH_JSON_BYTES = 16 * 1024;

const ACCOUNT_LIMITS: Record<string, AccountLimit> = {
  "/api/auth/sign-in/email": { limit: 10, windowSeconds: 15 * 60 },
  "/api/auth/sign-up/email": { limit: 5, windowSeconds: 60 * 60 },
  "/api/auth/forget-password": { limit: 3, windowSeconds: 60 * 60 },
  "/api/auth/request-password-reset": { limit: 3, windowSeconds: 60 * 60 },
  "/api/auth/send-verification-email": { limit: 3, windowSeconds: 60 * 60 },
};

function authPayloadTooLarge(): Response {
  return Response.json(
    { message: "Request body is too large." },
    {
      status: 413,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}

async function readBoundedEmail(req: Request): Promise<string | Response | undefined> {
  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AUTH_JSON_BYTES) {
    return authPayloadTooLarge();
  }
  const reader = req.clone().body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  let total = 0;
  let json = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_AUTH_JSON_BYTES) {
      void reader.cancel();
      return authPayloadTooLarge();
    }
    json += decoder.decode(value, { stream: true });
  }
  json += decoder.decode();
  try {
    const body = JSON.parse(json) as { email?: unknown };
    return typeof body.email === "string" ? body.email.trim().toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Adds a distributed account-key budget without persisting raw email addresses. */
export async function checkAuthAccountRateLimit(req: Request): Promise<Response | null> {
  if (req.method !== "POST") return null;
  const limit = ACCOUNT_LIMITS[new URL(req.url).pathname];
  if (!limit) return null;

  const parsedEmail = await readBoundedEmail(req);
  if (parsedEmail instanceof Response) return parsedEmail;
  const email = parsedEmail;
  if (!email) return null;

  const result = await consumeRateLimit({
    key: storageKey(`account:${email}:${new URL(req.url).pathname}`),
    ...limit,
  });
  if (result.ok) return null;

  return Response.json(
    { message: "Too many requests. Please try again later." },
    {
      status: 429,
      headers: {
        "Retry-After": String(result.retryAfterSeconds),
        "Cache-Control": "private, no-store",
      },
    },
  );
}
