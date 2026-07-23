import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/drafts/password";
import { draftFieldsSchema, draftPasswordSchema } from "@/lib/validation/api";

describe("draft password hashing", () => {
  it("rejects oversized passwords before hashing", () => {
    expect(draftPasswordSchema.safeParse("x".repeat(128)).success).toBe(true);
    expect(draftPasswordSchema.safeParse("x".repeat(129)).success).toBe(false);
  });

  it("rejects a password paired with non-password visibility", () => {
    expect(draftFieldsSchema.safeParse({ password: "secret" }).success).toBe(true);
    expect(
      draftFieldsSchema.safeParse({ visibility: "password", password: "secret" }).success,
    ).toBe(true);
    expect(draftFieldsSchema.safeParse({ visibility: "public", password: "secret" }).success).toBe(
      false,
    );
    expect(draftFieldsSchema.safeParse({ visibility: "private", password: "secret" }).success).toBe(
      false,
    );
  });

  it("verifies the correct password and rejects wrong ones", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong horse battery", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("uses a random salt so equal passwords hash differently", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  it("encodes as scrypt$N$r$p$salt$hash", async () => {
    const hash = await hashPassword("x");
    const parts = hash.split("$");
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe("scrypt");
  });

  it("rejects malformed stored hashes without throwing", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "scrypt$16384$8$1$onlyfiveparts")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$16384$8$1$aaaa$bbbb")).toBe(false);
  });
});
