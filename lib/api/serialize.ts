import type { ApiToken, Draft, DraftVersion } from "@/db/schema";
import { draftUrl } from "@/lib/urls";

export function serializeDraft(draft: Draft, versionNumber: number | null) {
  return {
    id: draft.id,
    title: draft.title,
    slug: draft.slug,
    visibility: draft.visibility,
    version: versionNumber,
    url: draftUrl(draft.slug),
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
}

export function serializeVersion(version: DraftVersion) {
  return {
    id: version.id,
    version: version.versionNumber,
    contentSha256: version.contentSha256,
    sizeBytes: version.sizeBytes,
    source: version.source,
    createdAt: version.createdAt.toISOString(),
  };
}

/** Never includes the hash; the full token exists only in the creation response. */
export function serializeToken(token: ApiToken) {
  return {
    id: token.id,
    name: token.name,
    tokenPrefix: token.tokenPrefix,
    scopes: token.scopes,
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    expiresAt: token.expiresAt?.toISOString() ?? null,
    createdAt: token.createdAt.toISOString(),
  };
}
