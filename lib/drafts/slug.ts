import { randomBytes, randomInt } from "node:crypto";

const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SUFFIX_LENGTH = 4;
const MAX_BASE_LENGTH = 60;

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BASE_LENGTH)
    .replace(/-+$/, "");
}

/** Title-independent, high-entropy slug for private/password content. */
export function generateProtectedSlug(): string {
  return `draft-${randomBytes(18).toString("base64url")}`;
}

/** Public drafts may be descriptive; protected drafts must never disclose title metadata. */
export function generateSlug(title: string, discloseTitle = true): string {
  if (!discloseTitle) return generateProtectedSlug();
  const base = slugify(title) || "draft";
  let suffix = "";
  for (let i = 0; i < SUFFIX_LENGTH; i++) {
    suffix += SUFFIX_ALPHABET[randomInt(SUFFIX_ALPHABET.length)];
  }
  return `${base}-${suffix}`;
}
