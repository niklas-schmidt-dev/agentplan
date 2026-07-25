import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { DraftPasswordForm } from "@/components/draft-password-form";
import { getDraftBySlug, getVersionById } from "@/db/queries/drafts";
import { readAccessCookie } from "@/lib/drafts/access";
import {
  bundleVersionPath,
  issueBundlePasswordGrant,
  issueBundleSessionGrant,
} from "@/lib/drafts/bundle-view-access";
import { getOptionalSession, getOptionalUser } from "@/lib/auth/session";
import { resolveDraftView, type ViewResolution } from "@/lib/drafts/view-access";

async function resolveView(slug: string): Promise<ViewResolution> {
  const draft = await getDraftBySlug(slug);
  const user = await getOptionalUser();
  const cookieHeader = (await headers()).get("cookie");
  return resolveDraftView(draft, {
    userId: user?.id ?? null,
    accessToken: draft ? readAccessCookie(cookieHeader, draft.id) : undefined,
  });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const resolution = await resolveView(slug);
  // Never leak a protected draft's title before access is granted.
  const title =
    resolution.state === "granted"
      ? resolution.draft.title
      : resolution.state === "password"
        ? "Password required"
        : "Not found";
  return { title, robots: { index: false } };
}

export default async function DraftViewerPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { slug } = await params;
  const resolution = await resolveView(slug);

  if (resolution.state === "not-found") notFound();

  if (resolution.state === "password") {
    const { error } = await searchParams;
    return (
      <DraftPasswordForm
        slug={slug}
        error={error === "rate" ? "rate-limited" : error === "1" ? "wrong-password" : undefined}
      />
    );
  }

  const contentUrl = `/p/${encodeURIComponent(slug)}/content`;
  if (resolution.draft.kind === "image") {
    return (
      <main className="fixed inset-0 grid min-h-dvh place-items-center bg-black p-4">
        {/* The raw response owns MIME validation and CSP; avoid next/image because it drops auth. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={contentUrl}
          alt={resolution.draft.title}
          className="max-h-full max-w-full object-contain"
        />
      </main>
    );
  }
  if (resolution.draft.kind === "video") {
    return (
      <main className="fixed inset-0 grid min-h-dvh place-items-center bg-black p-4">
        <video
          src={contentUrl}
          controls
          playsInline
          preload="metadata"
          className="max-h-full max-w-full"
          aria-label={resolution.draft.title}
        />
      </main>
    );
  }
  let htmlUrl = contentUrl;
  if (resolution.draft.currentVersionId) {
    const version = await getVersionById(resolution.draft.id, resolution.draft.currentVersionId);
    if (version?.isBundle) {
      let grant: string | undefined;
      if (resolution.draft.visibility !== "public") {
        const session = await getOptionalSession();
        if (session?.user.id === resolution.draft.ownerId) {
          grant = issueBundleSessionGrant({
            draftId: resolution.draft.id,
            versionId: version.id,
            sessionId: session.session.id,
          });
        } else if (resolution.draft.visibility === "password" && resolution.draft.passwordHash) {
          grant = issueBundlePasswordGrant({
            draftId: resolution.draft.id,
            versionId: version.id,
            passwordHash: resolution.draft.passwordHash,
          });
        }
      }
      htmlUrl = bundleVersionPath({
        slug,
        versionId: version.id,
        logicalPath: version.entryPath ?? "index.html",
        grant,
      });
    }
  }
  return (
    // Hostile-HTML boundary: never add allow-same-origin or any
    // allow-top-navigation variant to this sandbox.
    <iframe
      src={htmlUrl}
      sandbox="allow-scripts allow-forms allow-modals allow-popups"
      title={resolution.draft.title}
      className="fixed inset-0 h-dvh w-screen border-0 bg-white"
    />
  );
}
