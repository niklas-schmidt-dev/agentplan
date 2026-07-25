export type ByteRange = { ok: true; start: number; end: number } | { ok: false };

export function parseSingleByteRange(value: string, size: number): ByteRange {
  if (!value.startsWith("bytes=") || value.includes(",")) return { ok: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match) return { ok: false };
  const startRaw = match[1] ?? "";
  const endRaw = match[2] ?? "";
  if (!startRaw && !endRaw) return { ok: false };

  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { ok: false };
    return { ok: true, start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startRaw);
  const requestedEnd = endRaw ? Number(endRaw) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return { ok: false };
  }
  return { ok: true, start, end: Math.min(requestedEnd, size - 1) };
}

export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || value === etag || value === `W/${etag}`);
}
