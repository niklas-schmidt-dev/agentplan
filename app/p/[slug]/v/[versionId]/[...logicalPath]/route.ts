import { getDraftBySlug, getVersionAsset, getVersionById } from "@/db/queries/drafts";
import { authenticateSession } from "@/lib/api/auth";
import { readAccessCookie } from "@/lib/drafts/access";
import {
  authorizeBundleViewGrant,
  BUNDLE_VIEW_PATH_PREFIX,
  bundleVersionPath,
  issueBundlePasswordGrant,
  issueBundleSessionGrant,
} from "@/lib/drafts/bundle-view-access";
import { resolveDraftView } from "@/lib/drafts/view-access";
import { etagMatches, parseSingleByteRange } from "@/lib/http/range";
import { getStorage } from "@/lib/storage";
import { normalizeBundlePath } from "@agentplan/upload-contract";

export const runtime = "nodejs";
export const maxDuration = 300;

const HTML_SANDBOX = "sandbox allow-scripts allow-forms allow-modals allow-popups";
const MEDIA_SANDBOX = "sandbox";

function commonHeaders(contentSecurityPolicy: string): Headers {
  return new Headers({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": `${contentSecurityPolicy}; frame-ancestors 'self'`,
    "X-Robots-Tag": "noindex",
  });
}

function notFoundResponse(): Response {
  const headers = commonHeaders(MEDIA_SANDBOX);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "private, no-store");
  return new Response("Not found", { status: 404, headers });
}

type Params = {
  params: Promise<{ slug: string; versionId: string; logicalPath: string[] }>;
};

async function resolveBundleFile(req: Request, params: Awaited<Params["params"]>) {
  const draft = await getDraftBySlug(params.slug);
  if (!draft || draft.kind !== "html") return null;
  const version = await getVersionById(draft.id, params.versionId);
  if (!version?.isBundle) return null;
  const segments = params.logicalPath;
  const grantToken =
    segments[0] === BUNDLE_VIEW_PATH_PREFIX && segments.length >= 3 ? segments[1]! : null;
  const logicalSegments = grantToken ? segments.slice(2) : segments;
  let redirectGrant: string | undefined;
  if (draft.visibility !== "public") {
    if (grantToken) {
      if (!(await authorizeBundleViewGrant(grantToken, draft, version.id))) return null;
    } else {
      const session = await authenticateSession(req);
      const userId = session?.userId ?? null;
      const accessToken =
        draft.visibility === "password"
          ? readAccessCookie(req.headers.get("cookie"), draft.id)
          : undefined;
      if (resolveDraftView(draft, { userId, accessToken }).state !== "granted") return null;
      if (userId === draft.ownerId && session) {
        redirectGrant = issueBundleSessionGrant({
          draftId: draft.id,
          versionId: version.id,
          sessionId: session.sessionId,
        });
      } else if (draft.visibility === "password" && draft.passwordHash) {
        redirectGrant = issueBundlePasswordGrant({
          draftId: draft.id,
          versionId: version.id,
          passwordHash: draft.passwordHash,
        });
      }
    }
  }
  let logicalPath: string;
  try {
    logicalPath = normalizeBundlePath(logicalSegments.join("/"));
  } catch {
    return null;
  }
  const redirectLocation = redirectGrant
    ? bundleVersionPath({
        slug: params.slug,
        versionId: version.id,
        logicalPath,
        grant: redirectGrant,
      })
    : undefined;
  if (logicalPath === (version.entryPath ?? "index.html")) {
    return {
      draft,
      version,
      storageKey: version.storageKey,
      contentType: "text/html; charset=utf-8",
      contentSha256: version.contentSha256,
      sizeBytes: version.sizeBytes,
      isVideo: false,
      isHtml: true,
      redirectLocation,
    };
  }
  const asset = await getVersionAsset(version.id, logicalPath);
  if (!asset) return null;
  return {
    draft,
    version,
    storageKey: asset.storageKey,
    contentType: asset.contentType,
    contentSha256: asset.contentSha256,
    sizeBytes: asset.sizeBytes,
    isVideo: asset.contentType === "video/mp4",
    isHtml: false,
    redirectLocation,
  };
}

function fileHeaders(file: NonNullable<Awaited<ReturnType<typeof resolveBundleFile>>>): Headers {
  const headers = commonHeaders(file.isHtml ? HTML_SANDBOX : MEDIA_SANDBOX);
  headers.set("Content-Type", file.contentType);
  headers.set("Content-Disposition", "inline");
  headers.set("ETag", `"${file.contentSha256}"`);
  headers.set(
    "Cache-Control",
    file.draft.visibility === "public" ? "public, max-age=0, must-revalidate" : "private, no-store",
  );
  if (file.isVideo) headers.set("Accept-Ranges", "bytes");
  return headers;
}

async function storageMatches(
  file: NonNullable<Awaited<ReturnType<typeof resolveBundleFile>>>,
): Promise<boolean> {
  const stored = await getStorage().head(file.storageKey);
  return Boolean(
    stored &&
    stored.size === file.sizeBytes &&
    (!stored.contentType ||
      stored.contentType.split(";")[0]?.trim().toLowerCase() ===
        file.contentType.split(";")[0]?.trim().toLowerCase()),
  );
}

export async function HEAD(req: Request, { params }: Params): Promise<Response> {
  const file = await resolveBundleFile(req, await params);
  if (!file) return notFoundResponse();
  if (file.redirectLocation) {
    const headers = commonHeaders(file.isHtml ? HTML_SANDBOX : MEDIA_SANDBOX);
    headers.set("Location", file.redirectLocation);
    headers.set("Cache-Control", "private, no-store");
    return new Response(null, { status: 307, headers });
  }
  if (!(await storageMatches(file))) return notFoundResponse();
  const headers = fileHeaders(file);
  headers.set("Content-Length", String(file.sizeBytes));
  return new Response(null, { status: 200, headers });
}

export async function GET(req: Request, { params }: Params): Promise<Response> {
  const file = await resolveBundleFile(req, await params);
  if (!file) return notFoundResponse();
  if (file.redirectLocation) {
    const headers = commonHeaders(file.isHtml ? HTML_SANDBOX : MEDIA_SANDBOX);
    headers.set("Location", file.redirectLocation);
    headers.set("Cache-Control", "private, no-store");
    return new Response(null, { status: 307, headers });
  }
  const headers = fileHeaders(file);
  const etag = headers.get("ETag")!;
  if (etagMatches(req.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  if (!(await storageMatches(file))) return notFoundResponse();

  let range: { start: number; end: number } | undefined;
  const rangeHeader = file.isVideo ? req.headers.get("range") : null;
  if (rangeHeader) {
    const ifRange = req.headers.get("if-range");
    if (!ifRange || ifRange === etag) {
      const parsed = parseSingleByteRange(rangeHeader, file.sizeBytes);
      if (!parsed.ok) {
        headers.set("Content-Range", `bytes */${file.sizeBytes}`);
        return new Response(null, { status: 416, headers });
      }
      range = { start: parsed.start, end: parsed.end };
    }
  }

  const object = await getStorage().open(file.storageKey, range);
  if (!object) return notFoundResponse();
  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${file.sizeBytes}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(file.sizeBytes));
  return new Response(object.body, { status: 200, headers });
}
