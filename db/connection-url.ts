/**
 * PostgreSQL 17/libpq accepts `sslrootcert=system` to use the operating
 * system's trusted certificate store. node-postgres instead interprets every
 * `sslrootcert` value as a file path and tries to open a file named `system`.
 *
 * Removing only that sentinel keeps `sslmode=verify-full` intact, so Node's
 * normal trusted CA set is used and hostname/certificate verification remains
 * enabled.
 */
export function normalizeNodePostgresUrl(connectionString: string): string {
  const url = new URL(connectionString);

  for (const key of [...url.searchParams.keys()]) {
    if (
      key.toLowerCase() === "sslrootcert" &&
      url.searchParams.get(key)?.toLowerCase() === "system"
    ) {
      url.searchParams.delete(key);
    }
  }

  return url.toString();
}
