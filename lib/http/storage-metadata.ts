import type { StorageOpenResult } from "@/lib/storage";

/** Validate provider response metadata before forwarding a private stream. */
export function storageResponseMatches(
  object: StorageOpenResult,
  expected: { sizeBytes: number; contentType: string },
  range?: { start: number; end: number },
): boolean {
  if (
    object.contentType &&
    object.contentType.split(";")[0]?.trim().toLowerCase() !==
      expected.contentType.split(";")[0]?.trim().toLowerCase()
  )
    return false;
  if (!range) return object.size === expected.sizeBytes && !object.contentRange;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(object.contentRange ?? "");
  return Boolean(
    match &&
    Number(match[1]) === range.start &&
    Number(match[2]) === range.end &&
    Number(match[3]) === expected.sizeBytes &&
    object.size === range.end - range.start + 1,
  );
}
