import { getDraftBySlug, getVersionById } from "@/db/queries/drafts";
import { authenticateSession } from "@/lib/api/auth";
import { readAccessCookie } from "@/lib/drafts/access";
import { resolveDraftView } from "@/lib/drafts/view-access";
import { etagMatches, parseSingleByteRange } from "@/lib/http/range";
import { getStorage } from "@/lib/storage";

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

async function resolveContent(
  req: Request,
  slug: string,
): Promise<
  | {
      draft: NonNullable<Awaited<ReturnType<typeof getDraftBySlug>>>;
      version: NonNullable<Awaited<ReturnType<typeof getVersionById>>>;
    }
  | Response
> {
  const draft = await getDraftBySlug(slug);
  if (!draft || !draft.currentVersionId) return notFoundResponse();
  let userId: string | null = null;
  let accessToken: string | undefined;
  if (draft.visibility !== "public") {
    const session = await authenticateSession(req);
    userId = session?.userId ?? null;
    if (draft.visibility === "password") {
      accessToken = readAccessCookie(req.headers.get("cookie"), draft.id);
    }
  }
  if (resolveDraftView(draft, { userId, accessToken }).state !== "granted") {
    return notFoundResponse();
  }
  const version = await getVersionById(draft.id, draft.currentVersionId);
  if (!version) return notFoundResponse();
  return { draft, version };
}

function responseHeaders(
  draft: NonNullable<Awaited<ReturnType<typeof getDraftBySlug>>>,
  version: NonNullable<Awaited<ReturnType<typeof getVersionById>>>,
): Headers {
  const headers = commonHeaders(draft.kind === "html" ? HTML_SANDBOX : MEDIA_SANDBOX);
  headers.set(
    "Content-Type",
    draft.kind === "html" ? "text/html; charset=utf-8" : version.contentType,
  );
  headers.set("Content-Disposition", "inline");
  headers.set("ETag", `"${version.contentSha256}"`);
  headers.set(
    "Cache-Control",
    draft.visibility === "public" ? "public, max-age=0, must-revalidate" : "private, no-store",
  );
  if (draft.kind === "video") headers.set("Accept-Ranges", "bytes");
  return headers;
}

function bundleEntryLocation(
  slug: string,
  version: NonNullable<Awaited<ReturnType<typeof getVersionById>>>,
): string {
  const entryPath = version.entryPath ?? "index.html";
  const encodedPath = entryPath.split("/").map(encodeURIComponent).join("/");
  return `/p/${encodeURIComponent(slug)}/v/${version.id}/${encodedPath}`;
}

type Params = { params: Promise<{ slug: string }> };

export async function HEAD(req: Request, { params }: Params): Promise<Response> {
  const { slug } = await params;
  const resolved = await resolveContent(req, slug);
  if (resolved instanceof Response) return resolved;
  if (resolved.version.isBundle) {
    const headers = commonHeaders(HTML_SANDBOX);
    headers.set("Location", bundleEntryLocation(slug, resolved.version));
    headers.set("Cache-Control", "private, no-store");
    return new Response(null, { status: 307, headers });
  }
  const headers = responseHeaders(resolved.draft, resolved.version);
  headers.set("Content-Length", String(resolved.version.sizeBytes));
  return new Response(null, { status: 200, headers });
}

export async function GET(req: Request, { params }: Params): Promise<Response> {
  const { slug } = await params;
  const resolved = await resolveContent(req, slug);
  if (resolved instanceof Response) return resolved;
  const { draft, version } = resolved;
  if (version.isBundle) {
    const headers = commonHeaders(HTML_SANDBOX);
    headers.set("Location", bundleEntryLocation(slug, version));
    headers.set("Cache-Control", "private, no-store");
    return new Response(null, { status: 307, headers });
  }
  const headers = responseHeaders(draft, version);
  const etag = headers.get("ETag")!;
  if (etagMatches(req.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }

  let range: { start: number; end: number } | undefined;
  const rangeHeader = draft.kind === "video" ? req.headers.get("range") : null;
  if (rangeHeader) {
    const ifRange = req.headers.get("if-range");
    if (!ifRange || ifRange === etag) {
      const parsed = parseSingleByteRange(rangeHeader, version.sizeBytes);
      if (!parsed.ok) {
        headers.set("Content-Range", `bytes */${version.sizeBytes}`);
        return new Response(null, { status: 416, headers });
      }
      range = { start: parsed.start, end: parsed.end };
    }
  }

  const object = await getStorage().open(version.storageKey, range);
  if (!object) return notFoundResponse();
  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${version.sizeBytes}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(version.sizeBytes));
  return new Response(object.body, { status: 200, headers });
}
