"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDraftBySlug } from "@/db/queries/drafts";
import { recordAuditEvent } from "@/lib/audit/events";
import { accessCookieName, issueDraftAccess } from "@/lib/drafts/access";
import { verifyPassword } from "@/lib/drafts/password";

const ACCESS_TTL_SECONDS = 12 * 60 * 60;

export async function submitDraftPassword(formData: FormData): Promise<void> {
  const slug = String(formData.get("slug") ?? "");
  const password = String(formData.get("password") ?? "");
  const encodedSlug = encodeURIComponent(slug);

  const draft = await getDraftBySlug(slug);
  // Only password-protected drafts have a gate; anything else just falls through
  // to the normal viewer, which renders or 404s as appropriate.
  if (!draft || draft.visibility !== "password" || !draft.passwordHash) {
    redirect(`/p/${encodedSlug}`);
  }

  if (!(await verifyPassword(password, draft.passwordHash))) {
    await recordAuditEvent({
      type: "draft.visibility_changed",
      draftId: draft.id,
      metadata: { event: "password_attempt_failed" },
    });
    redirect(`/p/${encodedSlug}?error=1`);
  }

  const token = issueDraftAccess(draft.id, draft.passwordHash, ACCESS_TTL_SECONDS);
  const store = await cookies();
  store.set(accessCookieName(draft.id), token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: `/p/${slug}`,
    maxAge: ACCESS_TTL_SECONDS,
  });
  redirect(`/p/${encodedSlug}`);
}
