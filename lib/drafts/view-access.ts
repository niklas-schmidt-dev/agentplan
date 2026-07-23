import type { Draft } from "@/db/schema";
import { verifyDraftAccess } from "@/lib/drafts/access";

export type ViewResolution =
  | { state: "not-found" }
  | { state: "granted"; draft: Draft }
  | { state: "password"; draft: Draft };

/**
 * Single source of truth for who may view a draft. Callers pass the resolved
 * viewer identity and the raw draft-access token; this decides the outcome:
 *
 * - owner (signed in)         → always granted
 * - public                    → granted
 * - password + hash + valid token → granted
 * - password + hash + no/bad token → password prompt required
 * - password + missing hash   → not-found (fail closed)
 * - private (non-owner)       → indistinguishable not-found
 * - missing / deleted / no version → not-found
 */
export function resolveDraftView(
  draft: Draft | null,
  viewer: { userId: string | null; accessToken: string | undefined },
): ViewResolution {
  if (!draft || !draft.currentVersionId) return { state: "not-found" };

  const isOwner = viewer.userId !== null && viewer.userId === draft.ownerId;
  if (isOwner) return { state: "granted", draft };

  if (draft.visibility === "public") return { state: "granted", draft };

  if (draft.visibility === "password") {
    if (!draft.passwordHash) return { state: "not-found" };
    return verifyDraftAccess(viewer.accessToken, draft.id, draft.passwordHash)
      ? { state: "granted", draft }
      : { state: "password", draft };
  }

  return { state: "not-found" };
}
