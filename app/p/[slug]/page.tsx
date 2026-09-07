import { cache } from "react";
import { draftVersionPath } from "@/lib/urls";
import { uuidSchema } from "@/lib/validation/api";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { DraftPasswordForm } from "@/components/draft-password-form";
import { getDraftBySlug, getVersionById } from "@/db/queries/drafts";
import { classifyViewer, recordDraftView, viewRequestContext } from "@/lib/analytics/views";
import { readAccessCookie } from "@/lib/drafts/access";
import {
  bundleVersionPath,
  issueBundlePasswordGrant,
  issueBundleSessionGrant,
} from "@/lib/drafts/bundle-view-access";
import { getOptionalSession, getOptionalUser } from "@/lib/auth/session";
import { resolveDraftView, type ViewResolution } from "@/lib/drafts/view-access";

const resolveView = cache(async function resolveView(
  slug: string,
): Promise<{ resolution: ViewResolution; userId: string | null }> {
  const draft = await getDraftBySlug(slug);
  const user = await getOptionalUser();
  const cookieHeader = (await headers()).get("cookie");
  const resolution = resolveDraftView(draft, {
    userId: user?.id ?? null,
    accessToken: draft ? readAccessCookie(cookieHeader, draft.id) : undefined,
  });
  return { resolution, userId: user?.id ?? null };
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; versionId?: string }>;
}): Promise<Metadata> {
  const { slug, versionId } = await params;
  if (versionId !== undefined && !uuidSchema.safeParse(versionId).success) notFound();
  const { resolution } = await resolveView(slug);
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
  params: Promise<{ slug: string; versionId?: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { slug, versionId } = await params;
  if (versionId !== undefined && !uuidSchema.safeParse(versionId).success) notFound();
  const { resolution, userId } = await resolveView(slug);

  if (resolution.state === "not-found") notFound();

  if (resolution.state === "password") {
    const { error } = await searchParams;
    return (
      <DraftPasswordForm
        slug={slug}
        versionId={versionId}
        error={error === "rate" ? "rate-limited" : error === "1" ? "wrong-password" : undefined}
      />
    );
  }

  const selectedId = versionId ?? resolution.draft.currentVersionId;
  const version = selectedId ? await getVersionById(resolution.draft.id, selectedId) : null;
  if (!version) notFound();
  // Fire-and-forget after the response; a failed insert never blocks a view.
  const context = viewRequestContext(await headers());
  const event = {
    draftId: resolution.draft.id,
    versionId: version.id,
    viewer: classifyViewer(resolution.draft, userId),
    context,
  };
  after(() => recordDraftView(event));
  const contentUrl = `/p/${encodeURIComponent(slug)}/content?version=${version.id}`;
  const versionNavigation = versionId ? (
    <nav
      aria-label="Version navigation"
      className="fixed inset-x-0 top-0 z-10 flex h-10 items-center justify-between gap-4 border-b border-edge bg-canvas px-4 font-mono text-xs text-ink-muted"
    >
      <span>
        v{version.versionNumber}
        {version.id === resolution.draft.currentVersionId ? " · current" : " · previous version"}
      </span>
      <a href={draftVersionPath(slug)} className="text-lime hover:underline">
        view current version ↗
      </a>
    </nav>
  ) : null;
  if (resolution.draft.kind === "image") {
    return (
      <main
        className={`fixed inset-0 grid min-h-dvh place-items-center bg-black p-4 ${versionId ? "pt-14" : ""}`}
      >
        {versionNavigation}
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
      <main
        className={`fixed inset-0 grid min-h-dvh place-items-center bg-black p-4 ${versionId ? "pt-14" : ""}`}
      >
        {versionNavigation}
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
  if (version.isBundle) {
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
  return (
    <>
      {versionNavigation}
      {/* Hostile-HTML boundary: never add allow-same-origin or any
       allow-top-navigation variant to this sandbox. */}
      <iframe
        src={htmlUrl}
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        title={resolution.draft.title}
        className={`fixed inset-x-0 bottom-0 w-screen border-0 bg-white ${versionId ? "top-10 h-[calc(100dvh-2.5rem)]" : "top-0 h-dvh"}`}
      />
    </>
  );
}
