import {
  contentHeaders,
  contentNotFound,
  HTML_SANDBOX,
  storedContentResponse,
} from "@/lib/http/content-response";
import { uuidSchema } from "@/lib/validation/api";
import { getDraftBySlug, getVersionById } from "@/db/queries/drafts";
import { authenticateSession } from "@/lib/api/auth";
import { readAccessCookie } from "@/lib/drafts/access";
import {
  bundleVersionPath,
  issueBundlePasswordGrant,
  issueBundleSessionGrant,
} from "@/lib/drafts/bundle-view-access";
import { resolveDraftView } from "@/lib/drafts/view-access";

export const runtime = "nodejs";
export const maxDuration = 300;

async function resolveContent(
  req: Request,
  slug: string,
): Promise<
  | {
      draft: NonNullable<Awaited<ReturnType<typeof getDraftBySlug>>>;
      version: NonNullable<Awaited<ReturnType<typeof getVersionById>>>;
      sessionId: string | null;
      userId: string | null;
    }
  | Response
> {
  const draft = await getDraftBySlug(slug);
  if (!draft || !draft.currentVersionId) return contentNotFound();
  let userId: string | null = null;
  let sessionId: string | null = null;
  let accessToken: string | undefined;
  if (draft.visibility !== "public") {
    const session = await authenticateSession(req);
    userId = session?.userId ?? null;
    sessionId = session?.sessionId ?? null;
    if (draft.visibility === "password") {
      accessToken = readAccessCookie(req.headers.get("cookie"), draft.id);
    }
  }
  if (resolveDraftView(draft, { userId, accessToken }).state !== "granted") {
    return contentNotFound();
  }
  const requestedVersion = new URL(req.url).searchParams.get("version");
  if (requestedVersion !== null && !uuidSchema.safeParse(requestedVersion).success) {
    return contentNotFound();
  }
  const version = await getVersionById(draft.id, requestedVersion ?? draft.currentVersionId);
  if (!version) return contentNotFound();
  return { draft, version, sessionId, userId };
}

function bundleEntryLocation(
  slug: string,
  draft: NonNullable<Awaited<ReturnType<typeof getDraftBySlug>>>,
  version: NonNullable<Awaited<ReturnType<typeof getVersionById>>>,
  sessionId: string | null,
  userId: string | null,
): string {
  let grant: string | undefined;
  if (draft.visibility !== "public") {
    if (userId === draft.ownerId && sessionId) {
      grant = issueBundleSessionGrant({
        draftId: draft.id,
        versionId: version.id,
        sessionId,
      });
    } else if (draft.visibility === "password" && draft.passwordHash) {
      grant = issueBundlePasswordGrant({
        draftId: draft.id,
        versionId: version.id,
        passwordHash: draft.passwordHash,
      });
    }
  }
  return bundleVersionPath({
    slug,
    versionId: version.id,
    logicalPath: version.entryPath ?? "index.html",
    grant,
  });
}

type Params = { params: Promise<{ slug: string }> };

export async function GET(req: Request, { params }: Params): Promise<Response> {
  const { slug } = await params;
  const resolved = await resolveContent(req, slug);
  if (resolved instanceof Response) return resolved;
  const { draft, version } = resolved;
  if (version.isBundle) {
    const headers = contentHeaders(HTML_SANDBOX);
    headers.set(
      "Location",
      bundleEntryLocation(slug, draft, version, resolved.sessionId, resolved.userId),
    );
    headers.set("Cache-Control", "private, no-store");
    return new Response(null, { status: 307, headers });
  }
  return storedContentResponse(req, {
    storageKey: version.storageKey,
    contentType: draft.kind === "html" ? "text/html; charset=utf-8" : version.contentType,
    contentSha256: version.contentSha256,
    sizeBytes: version.sizeBytes,
    visibility: draft.visibility,
    isHtml: draft.kind === "html",
    isVideo: draft.kind === "video",
  });
}

export const HEAD = GET;
