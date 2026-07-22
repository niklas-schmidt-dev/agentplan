import { createHash, randomBytes, randomInt } from "node:crypto";

export const TOKEN_SCOPES = ["drafts:read", "drafts:write"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

const PREFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const PREFIX_LENGTH = 8;

export type GeneratedToken = {
  /** Full token — shown to the user exactly once, never stored. */
  token: string;
  /** Visible identifier stored alongside the hash, e.g. `ap_live_x7k2m9qa`. */
  tokenPrefix: string;
  /** SHA-256 hex of the full token — the only stored credential material. */
  tokenHash: string;
};

export function generateApiToken(): GeneratedToken {
  let visible = "";
  for (let i = 0; i < PREFIX_LENGTH; i++) {
    visible += PREFIX_ALPHABET[randomInt(PREFIX_ALPHABET.length)];
  }
  const secret = randomBytes(32).toString("base64url");
  const token = `ap_live_${visible}_${secret}`;
  return {
    token,
    tokenPrefix: `ap_live_${visible}`,
    tokenHash: hashToken(token),
  };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isTokenScope(value: string): value is TokenScope {
  return (TOKEN_SCOPES as readonly string[]).includes(value);
}
