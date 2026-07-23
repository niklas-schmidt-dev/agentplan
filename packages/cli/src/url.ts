function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function parseSecureHttpUrl(candidate: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalHostname(parsed.hostname))) {
    return null;
  }
  return parsed;
}

/** Validates the bearer-token destination before any request is made. */
export function normalizeApiBaseUrl(candidate: string): string {
  const parsed = parseSecureHttpUrl(candidate);
  if (!parsed || parsed.search || parsed.hash) {
    throw new Error("API URL must use HTTPS (HTTP is allowed only for localhost).");
  }
  return parsed.toString().replace(/\/$/, "");
}

/**
 * True only for secure, metacharacter-free URLs safe to pass to an OS opener.
 * Server responses are untrusted, so this guards `agentplan open` against both
 * command injection and unexpected cleartext navigation.
 */
export function isSafeHttpUrl(candidate: string): boolean {
  if (!parseSecureHttpUrl(candidate)) return false;
  // Conservative allowlist: agentplan URLs are always https://host/p/<slug>.
  // Excludes shell/cmd metacharacters (& | % ^ ! < > ( ) ; ' " * $ etc.).
  return /^[A-Za-z0-9\-._~:/?#@]+$/.test(candidate);
}
