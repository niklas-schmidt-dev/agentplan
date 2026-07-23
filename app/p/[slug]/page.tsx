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

  return (
    // Hostile-HTML boundary: never add allow-same-origin or any
    // allow-top-navigation variant to this sandbox.
    <iframe
      src={`/p/${encodeURIComponent(slug)}/content`}
      sandbox="allow-scripts allow-forms allow-modals allow-popups"
      title={resolution.draft.title}
      className="fixed inset-0 h-dvh w-screen border-0 bg-white"
    />
  );
}
