import { describe, expect, it, vi } from "vitest";

vi.stubEnv("BETTER_AUTH_SECRET", "bundle-view-test-secret-not-for-production");

import {
  authorizeBundleViewGrant,
  bundleVersionPath,
  issueBundlePasswordGrant,
  issueBundleSessionGrant,
} from "@/lib/drafts/bundle-view-access";
import type { Draft } from "@/db/schema";

describe("bundle view grants", () => {
  it("builds a version-pinned path whose relative URLs retain the grant prefix", () => {
    const path = bundleVersionPath({
      slug: "private-plan",
      versionId: "version-1",
      logicalPath: "nested/index.html",
      grant: "signed-token",
    });
    expect(path).toBe("/p/private-plan/v/version-1/__ap/signed-token/nested/index.html");
    expect(new URL("images/hero.png", `https://agentplan.app${path}`).pathname).toBe(
      "/p/private-plan/v/version-1/__ap/signed-token/nested/images/hero.png",
    );
    expect(new URL("../video/demo.mp4", `https://agentplan.app${path}`).pathname).toBe(
      "/p/private-plan/v/version-1/__ap/signed-token/video/demo.mp4",
    );
  });

  it("issues opaque session and password grants without exposing password hashes", () => {
    const sessionGrant = issueBundleSessionGrant({
      draftId: "draft-1",
      versionId: "version-1",
      sessionId: "session-1",
    });
    const passwordGrant = issueBundlePasswordGrant({
      draftId: "draft-1",
      versionId: "version-1",
      passwordHash: "secret-password-hash",
    });
    expect(sessionGrant).toContain(".");
    expect(passwordGrant).toContain(".");
    expect(passwordGrant).not.toContain("secret-password-hash");
  });

  it("binds password grants to the version, current password hash, and expiry", async () => {
    const draft = {
      id: "draft-1",
      ownerId: "owner-1",
      visibility: "password",
      passwordHash: "password-hash-1",
    } as Draft;
    const grant = issueBundlePasswordGrant({
      draftId: draft.id,
      versionId: "version-1",
      passwordHash: draft.passwordHash!,
    });
    expect(await authorizeBundleViewGrant(grant, draft, "version-1")).toBe(true);
    expect(await authorizeBundleViewGrant(`${grant}x`, draft, "version-1")).toBe(false);
    expect(await authorizeBundleViewGrant(grant, draft, "version-2")).toBe(false);
    expect(
      await authorizeBundleViewGrant(
        grant,
        { ...draft, passwordHash: "password-hash-2" },
        "version-1",
      ),
    ).toBe(false);

    const expired = issueBundlePasswordGrant({
      draftId: draft.id,
      versionId: "version-1",
      passwordHash: draft.passwordHash!,
      ttlSeconds: -1,
    });
    expect(await authorizeBundleViewGrant(expired, draft, "version-1")).toBe(false);
  });
});
