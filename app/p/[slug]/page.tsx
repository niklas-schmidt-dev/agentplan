import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDraftBySlug } from "@/db/queries/drafts";
import { getOptionalUser } from "@/lib/auth/session";
import type { Draft } from "@/db/schema";

async function getViewableDraft(slug: string): Promise<Draft | null> {
  const draft = await getDraftBySlug(slug);
  if (!draft) return null;
  if (draft.visibility === "private") {
    // Private means owner-only; everyone else gets an indistinguishable 404.
    const user = await getOptionalUser();
    if (!user || user.id !== draft.ownerId) return null;
  }
  return draft;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const draft = await getViewableDraft(slug);
  return { title: draft ? draft.title : "Not found", robots: { index: false } };
}

export default async function DraftViewerPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const draft = await getViewableDraft(slug);
  if (!draft || !draft.currentVersionId) notFound();

  return (
    // Hostile-HTML boundary: never add allow-same-origin or any
    // allow-top-navigation variant to this sandbox.
    <iframe
      src={`/p/${encodeURIComponent(slug)}/content`}
      sandbox="allow-scripts allow-forms allow-modals allow-popups"
      title={draft.title}
      className="fixed inset-0 h-dvh w-screen border-0 bg-white"
    />
  );
}
