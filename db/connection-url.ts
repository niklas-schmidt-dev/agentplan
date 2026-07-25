const LEGACY_SECURE_SSL_MODES = new Set(["prefer", "require", "verify-ca"]);

/**
 * Adapt libpq-style connection URLs to node-postgres without weakening TLS.
 *
 * node-postgres 8 treats `prefer`, `require`, and `verify-ca` as aliases for
 * `verify-full`, but emits a warning because version 9 will adopt libpq's
 * weaker meanings. Making `verify-full` explicit preserves today's secure
 * certificate and hostname verification across that upgrade. An explicit
 * `uselibpqcompat=true` remains untouched.
 *
 * PostgreSQL also accepts `sslrootcert=system` to use the operating system's
 * trusted certificate store. node-postgres instead interprets every
 * `sslrootcert` value as a file path and tries to open a file named `system`.
 * Removing only that sentinel lets Node use its normal trusted CA set.
 */
export function normalizeNodePostgresUrl(connectionString: string): string {
  const url = new URL(connectionString);
  const entries = [...url.searchParams.entries()];
  const usesLibpqCompatibility = entries.some(
    ([key, value]) => key.toLowerCase() === "uselibpqcompat" && value.toLowerCase() === "true",
  );

  for (const [key, value] of entries) {
    if (key.toLowerCase() === "sslrootcert" && value.toLowerCase() === "system") {
      url.searchParams.delete(key);
    }

    if (
      !usesLibpqCompatibility &&
      key.toLowerCase() === "sslmode" &&
      LEGACY_SECURE_SSL_MODES.has(value.toLowerCase())
    ) {
      url.searchParams.set(key, "verify-full");
    }
  }

  return url.toString();
}
