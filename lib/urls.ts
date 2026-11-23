function normalizeHttpUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

export function appUrl(): string {
  const configured =
    normalizeHttpUrl(process.env.NEXT_PUBLIC_APP_URL) ??
    normalizeHttpUrl(process.env.BETTER_AUTH_URL);
  if (configured) return configured;

  const currentDeployment = process.env.VERCEL_URL;
  const productionDeployment = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const vercelHostname =
    process.env.VERCEL_ENV === "production"
      ? (productionDeployment ?? currentDeployment)
      : (currentDeployment ?? productionDeployment);

  return vercelHostname ? `https://${vercelHostname.replace(/\/+$/, "")}` : "http://localhost:3000";
}

export function draftUrl(slug: string): string {
  return `${appUrl()}/p/${slug}`;
}

/** The UUID pins the bytes; omitting it follows the current version. */
export function draftVersionPath(slug: string, versionId?: string): string {
  const base = `/p/${encodeURIComponent(slug)}`;
  return versionId ? `${base}/v/${encodeURIComponent(versionId)}` : base;
}

/** Opens one HTML version top-level and starts the browser's print dialog for "Save as PDF". */
export function draftPrintPath(slug: string, versionId: string): string {
  return `/p/${encodeURIComponent(slug)}/content?version=${encodeURIComponent(versionId)}&print=1`;
}

export function draftVersionUrl(slug: string, versionId: string): string {
  return `${appUrl()}${draftVersionPath(slug, versionId)}`;
}

const RETURN_PATH_BASE = "http://return-path.invalid";

/**
 * Accepts only a same-origin path (e.g. `/p/slug`) to continue to after
 * sign-in. Absolute, protocol-relative, and backslash forms are rejected so a
 * `?next=` parameter can never become an open redirect.
 */
export function safeReturnPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return undefined;
  }
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return undefined;
  try {
    const url = new URL(value, RETURN_PATH_BASE);
    // Dot segments can normalize "/.//host" into a protocol-relative "//host".
    // Better Auth also rejects encoded separators in a relative callbackURL.
    if (
      url.origin !== RETURN_PATH_BASE ||
      url.pathname.startsWith("//") ||
      /%2f|%5c/i.test(url.pathname)
    ) {
      return undefined;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}
