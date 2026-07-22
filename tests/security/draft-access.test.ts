import { beforeAll, describe, expect, it } from "vitest";
import {
  accessCookieName,
  issueDraftAccess,
  readAccessCookie,
  verifyDraftAccess,
} from "@/lib/drafts/access";
import { resolveDraftView } from "@/lib/drafts/view-access";
import type { Draft } from "@/db/schema";

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET ??= "draft-access-test-secret-000000000000";
});

const DRAFT_A = "11111111-1111-1111-1111-111111111111";
const DRAFT_B = "22222222-2222-2222-2222-222222222222";
const HASH_A = "scrypt$16384$8$1$c2FsdC1h$aGFzaC1h";
const HASH_B = "scrypt$16384$8$1$c2FsdC1i$aGFzaC1i";

describe("draft access token", () => {
  it("verifies a freshly issued token for its own draft", () => {
    const token = issueDraftAccess(DRAFT_A, HASH_A);
    expect(verifyDraftAccess(token, DRAFT_A, HASH_A)).toBe(true);
  });

  it("is bound to a single draft id", () => {
    const token = issueDraftAccess(DRAFT_A, HASH_A);
    expect(verifyDraftAccess(token, DRAFT_B, HASH_A)).toBe(false);
  });

  it("invalidates an existing grant when the password hash changes", () => {
    const token = issueDraftAccess(DRAFT_A, HASH_A);
    expect(verifyDraftAccess(token, DRAFT_A, HASH_B)).toBe(false);
    expect(verifyDraftAccess(token, DRAFT_A, null)).toBe(false);
  });

  it("rejects tampered payloads and signatures", () => {
    const token = issueDraftAccess(DRAFT_A, HASH_A);
    const [payload, sig] = [
      token.slice(0, token.lastIndexOf(".")),
      token.slice(token.lastIndexOf(".") + 1),
    ];
    expect(verifyDraftAccess(`${payload}.${sig}x`, DRAFT_A, HASH_A)).toBe(false);
    expect(verifyDraftAccess(`${DRAFT_A}.9999999999.${sig}`, DRAFT_A, HASH_A)).toBe(false);
    expect(verifyDraftAccess(undefined, DRAFT_A, HASH_A)).toBe(false);
    expect(verifyDraftAccess("garbage", DRAFT_A, HASH_A)).toBe(false);
  });

  it("rejects expired tokens", () => {
    const token = issueDraftAccess(DRAFT_A, HASH_A, -10);
    expect(verifyDraftAccess(token, DRAFT_A, HASH_A)).toBe(false);
  });
});

describe("readAccessCookie", () => {
  it("extracts the draft-scoped access cookie from a Cookie header", () => {
    const token = issueDraftAccess(DRAFT_A, HASH_A);
    const header = `other=1; ${accessCookieName(DRAFT_A)}=${token}; foo=bar`;
    expect(readAccessCookie(header, DRAFT_A)).toBe(token);
    expect(readAccessCookie(header, DRAFT_B)).toBeUndefined();
    expect(readAccessCookie(null, DRAFT_A)).toBeUndefined();
  });
});

function draft(overrides: Partial<Draft>): Draft {
  return {
    id: DRAFT_A,
    ownerId: "owner-1",
    slug: "s",
    title: "t",
    visibility: "private",
    passwordHash: null,
    currentVersionId: "v1",
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

describe("resolveDraftView", () => {
  it("not-found for missing draft or no current version", () => {
    expect(resolveDraftView(null, { userId: null, accessToken: undefined }).state).toBe("not-found");
    expect(
      resolveDraftView(draft({ currentVersionId: null }), { userId: null, accessToken: undefined })
        .state,
    ).toBe("not-found");
  });

  it("owner is always granted regardless of visibility", () => {
    for (const visibility of ["private", "public", "password"] as const) {
      expect(
        resolveDraftView(draft({ visibility }), { userId: "owner-1", accessToken: undefined }).state,
      ).toBe("granted");
    }
  });

  it("public is granted to anyone", () => {
    expect(
      resolveDraftView(draft({ visibility: "public" }), { userId: null, accessToken: undefined })
        .state,
    ).toBe("granted");
  });

  it("private is not-found for non-owners", () => {
    expect(
      resolveDraftView(draft({ visibility: "private" }), { userId: "other", accessToken: undefined })
        .state,
    ).toBe("not-found");
  });

  it("password requires a valid access token, else prompts", () => {
    const d = draft({ visibility: "password", passwordHash: HASH_A });
    expect(resolveDraftView(d, { userId: null, accessToken: undefined }).state).toBe("password");
    expect(resolveDraftView(d, { userId: null, accessToken: "bad" }).state).toBe("password");
    expect(
      resolveDraftView(d, { userId: null, accessToken: issueDraftAccess(DRAFT_A, HASH_A) }).state,
    ).toBe("granted");
    // A valid token for a different draft does not unlock this one.
    expect(
      resolveDraftView(d, { userId: null, accessToken: issueDraftAccess(DRAFT_B, HASH_A) }).state,
    ).toBe("password");
  });

  it("fails closed when password visibility has no stored hash", () => {
    const oldGrant = issueDraftAccess(DRAFT_A, HASH_A);
    expect(
      resolveDraftView(draft({ visibility: "password", passwordHash: null }), {
        userId: null,
        accessToken: oldGrant,
      }).state,
    ).toBe("not-found");
  });
});
