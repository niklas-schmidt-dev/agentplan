import { timingSafeEqual } from "node:crypto";

/** Constant-time comparison of two equal-purpose strings (e.g. hex hashes). */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
