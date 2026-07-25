import { createHmac, timingSafeEqual } from "node:crypto";

function secret(): string {
  const value = process.env.BETTER_AUTH_SECRET;
  if (!value) throw new Error("BETTER_AUTH_SECRET is required for upload tokens");
  return value;
}

export function issueUploadIntentToken(input: {
  intentId: string;
  ownerId: string;
  stagingKey: string;
  provider: "fs" | "r2" | "vercel-blob";
  expiresAt: Date;
}): string {
  const payload = Buffer.from(
    JSON.stringify({
      i: input.intentId,
      o: input.ownerId,
      k: input.stagingKey,
      p: input.provider,
      e: Math.floor(input.expiresAt.getTime() / 1000),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret())
    .update("upload-intent\0")
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyUploadIntentToken(token: string): {
  intentId: string;
  ownerId: string;
  stagingKey: string;
  provider: "fs" | "r2" | "vercel-blob";
  expiresAt: number;
} | null {
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = createHmac("sha256", secret())
    .update("upload-intent\0")
    .update(payload)
    .digest("base64url");
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      i?: unknown;
      o?: unknown;
      k?: unknown;
      p?: unknown;
      e?: unknown;
    };
    if (
      typeof value.i !== "string" ||
      typeof value.o !== "string" ||
      typeof value.k !== "string" ||
      (value.p !== "fs" && value.p !== "r2" && value.p !== "vercel-blob") ||
      typeof value.e !== "number" ||
      value.e <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return {
      intentId: value.i,
      ownerId: value.o,
      stagingKey: value.k,
      provider: value.p,
      expiresAt: value.e,
    };
  } catch {
    return null;
  }
}
