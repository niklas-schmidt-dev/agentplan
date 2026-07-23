"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDraftForOwner, getVersionById } from "@/db/queries/drafts";
import { requireUser } from "@/lib/auth/session";
import {
  restoreVersion,
  setDraftPassword,
  setDraftTitle,
  setDraftVisibility,
  softDeleteDraft,
} from "@/lib/drafts/service";
import { QuotaExceededError, RateLimitedError } from "@/lib/limits/errors";
import { consumeUploadRateLimit } from "@/lib/limits/enforce";
import { createToken, revokeToken } from "@/lib/tokens/service";
import { createTokenSchema, draftPasswordSchema, uuidSchema, visibilitySchema } from "@/lib/validation/api";
import { normalizeTitle } from "@/lib/validation/upload";
import type { Draft } from "@/db/schema";

/** User-facing message for quota/rate-limit rejections; null for other errors. */
function limitErrorMessage(error: unknown): string | null {
  if (error instanceof QuotaExceededError) return error.message;
  if (error instanceof RateLimitedError) {
    const minutes = Math.max(1, Math.ceil(error.retryAfterSeconds / 60));
    return `Rate limit exceeded. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  }
  return null;
}

async function requireOwnedDraft(rawDraftId: unknown): Promise<{ userId: string; draft: Draft }> {
  const user = await requireUser();
  const draftId = uuidSchema.safeParse(rawDraftId);
  const draft = draftId.success ? await getDraftForOwner(draftId.data, user.id) : null;
  if (!draft) redirect("/dashboard");
  return { userId: user.id, draft };
}

/** Handles the public/private buttons. Switching to password is done via
 *  setDraftPasswordAction, which carries the required password. */
export async function setVisibilityAction(formData: FormData): Promise<void> {
  const { userId, draft } = await requireOwnedDraft(formData.get("draftId"));
  const visibility = visibilitySchema.safeParse(formData.get("visibility"));
  if (
    visibility.success &&
    visibility.data !== "password" &&
    visibility.data !== draft.visibility
  ) {
    await setDraftVisibility(draft, visibility.data, { userId });
  }
  revalidatePath(`/dashboard/drafts/${draft.id}`);
  revalidatePath("/dashboard");
}

export type PasswordActionState = { error: string } | { ok: true } | null;

/** Sets or rotates a draft password and marks it password-protected. */
export async function setDraftPasswordAction(
  _prev: PasswordActionState,
  formData: FormData,
): Promise<PasswordActionState> {
  const { userId, draft } = await requireOwnedDraft(formData.get("draftId"));
  const parsed = draftPasswordSchema.safeParse(formData.get("password"));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid password." };
  }
  await setDraftPassword(draft, parsed.data, { userId });
  revalidatePath(`/dashboard/drafts/${draft.id}`);
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function renameDraftAction(formData: FormData): Promise<void> {
  const { userId, draft } = await requireOwnedDraft(formData.get("draftId"));
  const rawTitle = formData.get("title");
  if (typeof rawTitle === "string" && rawTitle.trim()) {
    await setDraftTitle(draft, normalizeTitle(rawTitle), { userId });
  }
  revalidatePath(`/dashboard/drafts/${draft.id}`);
  revalidatePath("/dashboard");
}

export async function deleteDraftAction(formData: FormData): Promise<void> {
  const { userId, draft } = await requireOwnedDraft(formData.get("draftId"));
  await softDeleteDraft(draft, { userId });
  revalidatePath("/dashboard");
  redirect("/dashboard");
}

export async function restoreVersionAction(formData: FormData): Promise<void> {
  const { draft } = await requireOwnedDraft(formData.get("draftId"));
  const versionId = uuidSchema.safeParse(formData.get("versionId"));
  if (versionId.success) {
    const version = await getVersionById(draft.id, versionId.data);
    if (version) {
      try {
        await consumeUploadRateLimit(draft.ownerId);
        await restoreVersion({
          draft,
          version,
          source: "browser",
          rateLimitConsumed: true,
        });
      } catch (error) {
        // No error channel on this plain form action; a limit rejection just
        // leaves the page unchanged instead of surfacing a 500.
        if (!limitErrorMessage(error)) throw error;
        console.warn("restoreVersionAction rate/quota limited", error);
      }
    }
  }
  revalidatePath(`/dashboard/drafts/${draft.id}`);
}

export type CreateTokenState =
  | { secret: string; name: string }
  | { error: string }
  | null;

export async function createTokenAction(
  _prev: CreateTokenState,
  formData: FormData,
): Promise<CreateTokenState> {
  const user = await requireUser();
  const scopes = formData.getAll("scopes").filter((s): s is string => typeof s === "string");
  const parsed = createTokenSchema.safeParse({
    name: formData.get("name"),
    scopes: scopes.length ? scopes : undefined,
    expiresInDays: formData.get("expiresInDays")
      ? Number(formData.get("expiresInDays"))
      : undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid token settings." };
  }

  try {
    const expiresAt = parsed.data.expiresInDays
      ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000)
      : undefined;
    const created = await createToken({
      userId: user.id,
      name: parsed.data.name,
      scopes: parsed.data.scopes,
      expiresAt,
    });
    revalidatePath("/dashboard/settings/tokens");
    return { secret: created.token, name: created.record.name };
  } catch (error) {
    const limitError = limitErrorMessage(error);
    if (limitError) return { error: limitError };
    console.error("createTokenAction failed", error);
    return { error: "Could not create the token. Please try again." };
  }
}

export async function revokeTokenAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const tokenId = uuidSchema.safeParse(formData.get("tokenId"));
  if (tokenId.success) {
    try {
      await revokeToken(user.id, tokenId.data);
    } catch (error) {
      if (!limitErrorMessage(error)) throw error;
    }
  }
  revalidatePath("/dashboard/settings/tokens");
}
