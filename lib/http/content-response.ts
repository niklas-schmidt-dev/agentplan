import type { Visibility } from "@/db/schema";
import { getStorage } from "@/lib/storage";
import { etagMatches, parseSingleByteRange } from "./range";
import { storageResponseMatches } from "./storage-metadata";

export const HTML_SANDBOX = "sandbox allow-scripts allow-forms allow-modals allow-popups";
export const MEDIA_SANDBOX = "sandbox";

export function contentHeaders(contentSecurityPolicy: string): Headers {
  return new Headers({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": `${contentSecurityPolicy}; frame-ancestors 'self'`,
    "X-Robots-Tag": "noindex",
  });
}

export function contentNotFound(): Response {
  const headers = contentHeaders(MEDIA_SANDBOX);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "private, no-store");
  return new Response("Not found", { status: 404, headers });
}

/** Call only after authorizing the request against the current draft and version. */
export async function storedContentResponse(
  req: Request,
  file: {
    storageKey: string;
    contentType: string;
    contentSha256: string;
    sizeBytes: number;
    visibility: Visibility;
    isHtml: boolean;
    isVideo: boolean;
  },
): Promise<Response> {
  const headers = contentHeaders(file.isHtml ? HTML_SANDBOX : MEDIA_SANDBOX);
  headers.set("Content-Type", file.contentType);
  headers.set("Content-Disposition", "inline");
  const etag = `"${file.contentSha256}"`;
  headers.set("ETag", etag);
  headers.set(
    "Cache-Control",
    file.visibility === "public" ? "public, max-age=0, must-revalidate" : "private, no-store",
  );
  if (file.isVideo) headers.set("Accept-Ranges", "bytes");

  if (req.method === "HEAD") {
    const metadata = await getStorage().head(file.storageKey);
    if (!metadata || !storageResponseMatches(metadata, file)) return contentNotFound();
    headers.set("Content-Length", String(file.sizeBytes));
    return new Response(null, { status: 200, headers });
  }
  if (etagMatches(req.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }

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
  if (!object) return contentNotFound();
  if (!storageResponseMatches(object, file, range)) {
    await object.body.cancel().catch(() => undefined);
    return contentNotFound();
  }
  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${file.sizeBytes}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(file.sizeBytes));
  return new Response(object.body, { status: 200, headers });
}
