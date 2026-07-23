"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDraftBySlug } from "@/db/queries/drafts";
import { recordAuditEvent } from "@/lib/audit/events";
import { accessCookieName, issueDraftAccess } from "@/lib/drafts/access";
import { verifyPassword } from "@/lib/drafts/password";
import { checkPasswordAttempt } from "@/lib/limits/enforce";
import { draftPasswordSchema } from "@/lib/validation/api";

const ACCESS_TTL_SECONDS = 12 * 60 * 60;

async function clientIdentifier(): Promise<string | null> {
  const requestHeaders = await headers();
  // First hop of x-forwarded-for is the client; Vercel's proxy sets it.
  const forwarded = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip =
    forwarded ||
    requestHeaders.get("x-real-ip")?.trim() ||
    requestHeaders.get("cf-connecting-ip")?.trim();
  if (ip) return `ip:${ip}`;

  // Defensive non-Vercel fallback. It is less authoritative and spoofable, but
  // avoids putting every unidentified viewer into one shared lockout bucket.
  const userAgent = requestHeaders.get("user-agent")?.trim();
  const language = requestHeaders.get("accept-language")?.trim();
  return userAgent ? `fallback:${userAgent}:${language ?? ""}` : null;
}

export async function submitDraftPassword(formData: FormData): Promise<void> {
  const slug = String(formData.get("slug") ?? "");
  const password = draftPasswordSchema.safeParse(formData.get("password"));
  const encodedSlug = encodeURIComponent(slug);

  const draft = await getDraftBySlug(slug);
  // Only password-protected drafts have a gate; anything else just falls through
  // to the normal viewer, which renders or 404s as appropriate.
  if (!draft || draft.visibility !== "password" || !draft.passwordHash) {
    redirect(`/p/${encodedSlug}`);
  }

  // Brute-force gate before any hash verification work.
  const attempt = await checkPasswordAttempt(draft.id, await clientIdentifier());
  if (!attempt.ok) {
    await recordAuditEvent({
      type: "draft.visibility_changed",
      draftId: draft.id,
      metadata: { event: "password_attempt_rate_limited" },
    });
    redirect(`/p/${encodedSlug}?error=rate`);
  }

  if (!password.success || !(await verifyPassword(password.data, draft.passwordHash))) {
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
