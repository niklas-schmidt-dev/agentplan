import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { sessions, users, type Draft } from "@/db/schema";

export const BUNDLE_VIEW_PATH_PREFIX = "__ap";
const DEFAULT_TTL_SECONDS = 12 * 60 * 60;

type BundleViewGrantPayload =
  | {
      draftId: string;
      versionId: string;
      kind: "session";
      sessionId: string;
      expiresAt: number;
    }
  | {
      draftId: string;
      versionId: string;
      kind: "password";
      expiresAt: number;
    };

function secret(): string {
  const value = process.env.BETTER_AUTH_SECRET;
  if (!value) throw new Error("BETTER_AUTH_SECRET is not set");
  return value;
}

function signingContext(payload: BundleViewGrantPayload, passwordHash?: string): string | null {
  if (payload.kind === "session") return `session:${payload.sessionId}`;
  return passwordHash ? `password:${passwordHash}` : null;
}

function sign(encodedPayload: string, context: string): string {
  return createHmac("sha256", secret())
    .update("bundle-view-access\0")
    .update(context)
    .update("\0")
    .update(encodedPayload)
    .digest("base64url");
}

function encode(payload: BundleViewGrantPayload, context: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload, context)}`;
}

export function issueBundleSessionGrant(input: {
  draftId: string;
  versionId: string;
  sessionId: string;
  ttlSeconds?: number;
}): string {
  const payload: BundleViewGrantPayload = {
    draftId: input.draftId,
    versionId: input.versionId,
    kind: "session",
    sessionId: input.sessionId,
    expiresAt: Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };
  return encode(payload, signingContext(payload)!);
}

export function issueBundlePasswordGrant(input: {
  draftId: string;
  versionId: string;
  passwordHash: string;
  ttlSeconds?: number;
}): string {
  const payload: BundleViewGrantPayload = {
    draftId: input.draftId,
    versionId: input.versionId,
    kind: "password",
    expiresAt: Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };
  return encode(payload, signingContext(payload, input.passwordHash)!);
}

function parseGrant(token: string, passwordHash?: string): BundleViewGrantPayload | null {
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const encodedPayload = token.slice(0, separator);
  const providedSignature = token.slice(separator + 1);
  let payload: BundleViewGrantPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload.draftId !== "string" ||
    typeof payload.versionId !== "string" ||
    !Number.isInteger(payload.expiresAt) ||
    payload.expiresAt <= Math.floor(Date.now() / 1000) ||
    (payload.kind !== "session" && payload.kind !== "password") ||
    (payload.kind === "session" && typeof payload.sessionId !== "string")
  ) {
    return null;
  }
  const context = signingContext(payload, passwordHash);
  if (!context) return null;
  const expectedSignature = sign(encodedPayload, context);
  const provided = Buffer.from(providedSignature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  return payload;
}

export async function authorizeBundleViewGrant(
  token: string,
  draft: Draft,
  versionId: string,
): Promise<boolean> {
  const payload = parseGrant(token, draft.passwordHash ?? undefined);
  if (!payload || payload.draftId !== draft.id || payload.versionId !== versionId) return false;
  if (payload.kind === "password") {
    return draft.visibility === "password" && Boolean(draft.passwordHash);
  }
  const [activeSession] = await getDb()
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.id, payload.sessionId),
        eq(sessions.userId, draft.ownerId),
        gt(sessions.expiresAt, new Date()),
        isNull(users.blockedAt),
      ),
    )
    .limit(1);
  return Boolean(activeSession);
}

export function bundleVersionPath(input: {
  slug: string;
  versionId: string;
  logicalPath: string;
  grant?: string;
}): string {
  const encodedPath = input.logicalPath.split("/").map(encodeURIComponent).join("/");
  const prefix = `/p/${encodeURIComponent(input.slug)}/v/${input.versionId}`;
  return input.grant
    ? `${prefix}/${BUNDLE_VIEW_PATH_PREFIX}/${encodeURIComponent(input.grant)}/${encodedPath}`
    : `${prefix}/${encodedPath}`;
}
