import { createHmac, timingSafeEqual } from "node:crypto";

// A visitor who enters the correct password for a password-protected draft
// receives this signed, draft-scoped grant as an HttpOnly cookie so they are
// not re-prompted on every request. The grant is bound to a single draft id
// and expires; it is NOT a general session and conveys no account identity.

const DEFAULT_TTL_SECONDS = 12 * 60 * 60; // 12 hours
export const ACCESS_COOKIE_PREFIX = "ap_access_";

function secret(): string {
  const value = process.env.BETTER_AUTH_SECRET;
  if (!value) throw new Error("BETTER_AUTH_SECRET is not set");
  return value;
}

export function accessCookieName(draftId: string): string {
  return `${ACCESS_COOKIE_PREFIX}${draftId}`;
}

function sign(payload: string, passwordHash: string): string {
  return createHmac("sha256", secret())
    .update("draft-access\0")
    .update(passwordHash)
    .update("\0")
    .update(payload)
    .digest("base64url");
}

/**
 * Returns a token proving password access to `draftId`, valid for `ttlSeconds`.
 * Binding the signature to the stored password hash invalidates every existing
 * grant when the owner rotates or removes the password.
 */
export function issueDraftAccess(
  draftId: string,
  passwordHash: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): string {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${draftId}.${expiresAt}`;
  return `${payload}.${sign(payload, passwordHash)}`;
}

/** Reads a specific draft's access token out of a raw Cookie header string. */
export function readAccessCookie(cookieHeader: string | null, draftId: string): string | undefined {
  if (!cookieHeader) return undefined;
  const name = accessCookieName(draftId);
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function verifyDraftAccess(
  token: string | undefined,
  draftId: string,
  passwordHash: string | null,
): boolean {
  if (!token || !passwordHash) return false;
  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0) return false;
  const payload = token.slice(0, lastDot);
  const signature = token.slice(lastDot + 1);

  const expected = sign(payload, passwordHash);
  const provided = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length || !timingSafeEqual(provided, expectedBuf)) {
    return false;
  }

  const [tokenDraftId, expiresRaw] = payload.split(".");
  if (tokenDraftId !== draftId) return false;
  const expiresAt = Number(expiresRaw);
  if (!Number.isInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;
  return true;
}
