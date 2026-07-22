/**
 * True only for plain http/https URLs whose every character is safe to hand to
 * an OS opener (including the Windows `cmd /c start` path). Server responses are
 * untrusted, so this guards `agentplan open` against command injection.
 */
export function isSafeHttpUrl(candidate: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // Conservative allowlist: agentplan URLs are always https://host/p/<slug>.
  // Excludes shell/cmd metacharacters (& | % ^ ! < > ( ) ; ' " * $ etc.).
  return /^[A-Za-z0-9\-._~:/?#@]+$/.test(candidate);
}
