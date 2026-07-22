import { getDraftBySlug, getVersionById } from "@/db/queries/drafts";
import { authenticateSession } from "@/lib/api/auth";
import { readAccessCookie } from "@/lib/drafts/access";
import { resolveDraftView } from "@/lib/drafts/view-access";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";

// Applied even on direct navigation to this URL: the CSP sandbox directive
// (without allow-same-origin) puts the document in an opaque origin, so the
// hostile HTML can never run with agentplan.app's origin or cookies.
const CONTENT_SANDBOX = "sandbox allow-scripts allow-forms allow-modals allow-popups";

function notFoundResponse(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const draft = await getDraftBySlug(slug);
  if (!draft || !draft.currentVersionId) return notFoundResponse();

  // Public content stays independent of the auth backend. Private/password
  // drafts still authorize through the single resolver below.
  let userId: string | null = null;
  let accessToken: string | undefined;
  if (draft.visibility !== "public") {
    const session = await authenticateSession(req);
    userId = session?.userId ?? null;
    if (draft.visibility === "password") {
      accessToken = readAccessCookie(req.headers.get("cookie"), draft.id);
    }
  }
  const resolution = resolveDraftView(draft, {
    userId,
    accessToken,
  });
  if (resolution.state !== "granted") return notFoundResponse();

  const version = await getVersionById(draft.id, draft.currentVersionId);
  if (!version) return notFoundResponse();

  const bytes = await getStorage().get(version.storageKey);
  if (!bytes) return notFoundResponse();

  // Copy into a fresh ArrayBuffer-backed view; satisfies BodyInit's typing.
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": String(bytes.byteLength),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `${CONTENT_SANDBOX}; frame-ancestors 'self'`,
      "X-Robots-Tag": "noindex",
      "Cache-Control":
        draft.visibility === "public" ? "public, max-age=0, must-revalidate" : "private, no-store",
    },
  });
}
