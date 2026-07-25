import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { DraftPasswordForm } from "@/components/draft-password-form";
import { getDraftBySlug } from "@/db/queries/drafts";
import { readAccessCookie } from "@/lib/drafts/access";
import { getOptionalUser } from "@/lib/auth/session";
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
  return (
    // Hostile-HTML boundary: never add allow-same-origin or any
    // allow-top-navigation variant to this sandbox.
    <iframe
      src={contentUrl}
      sandbox="allow-scripts allow-forms allow-modals allow-popups"
      title={resolution.draft.title}
      className="fixed inset-0 h-dvh w-screen border-0 bg-white"
    />
  );
}
