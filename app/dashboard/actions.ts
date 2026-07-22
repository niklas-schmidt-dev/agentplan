"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDraftForOwner, getVersionById } from "@/db/queries/drafts";
import { requireUser } from "@/lib/auth/session";
import {
  addVersionToDraft,
  createDraftWithFirstVersion,
  restoreVersion,
  setDraftTitle,
  setDraftVisibility,
  softDeleteDraft,
} from "@/lib/drafts/service";
import { createToken, revokeToken } from "@/lib/tokens/service";
import { createTokenSchema, uuidSchema, visibilitySchema } from "@/lib/validation/api";
import { normalizeTitle, titleFromFilename, validateUpload } from "@/lib/validation/upload";
import type { Draft } from "@/db/schema";

export type UploadState = { error: string } | null;

async function readUploadFile(formData: FormData): Promise<
  { bytes: Uint8Array; filename: string } | { error: string }
> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.name === "") {
    return { error: "Choose an HTML file to upload." };
  }
  const validationError = validateUpload({
    filename: file.name,
    contentType: file.type || null,
    sizeBytes: file.size,
  });
  if (validationError) return { error: validationError.message };
  return { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name };
}

export async function uploadDraftAction(
  _prev: UploadState,
  formData: FormData,
): Promise<UploadState> {
  const user = await requireUser();

  const upload = await readUploadFile(formData);
  if ("error" in upload) return { error: upload.error };

  const rawTitle = formData.get("title");
  const title =
    typeof rawTitle === "string" && rawTitle.trim()
      ? normalizeTitle(rawTitle)
      : titleFromFilename(upload.filename);
  const visibility = visibilitySchema.safeParse(formData.get("visibility"));

  let draftId: string;
  try {
    const { draft } = await createDraftWithFirstVersion({
      ownerId: user.id,
      title,
      visibility: visibility.success ? visibility.data : "private",
      bytes: upload.bytes,
      source: "browser",
    });
    draftId = draft.id;
  } catch (error) {
    console.error("uploadDraftAction failed", error);
    return { error: "Upload failed. Please try again." };
  }
  redirect(`/dashboard/drafts/${draftId}`);
}

async function requireOwnedDraft(rawDraftId: unknown): Promise<{ userId: string; draft: Draft }> {
  const user = await requireUser();
  const draftId = uuidSchema.safeParse(rawDraftId);
  const draft = draftId.success ? await getDraftForOwner(draftId.data, user.id) : null;
  if (!draft) redirect("/dashboard");
  return { userId: user.id, draft };
}

export async function uploadVersionAction(
  _prev: UploadState,
  formData: FormData,
): Promise<UploadState> {
  const { draft } = await requireOwnedDraft(formData.get("draftId"));

  const upload = await readUploadFile(formData);
  if ("error" in upload) return { error: upload.error };

  try {
    await addVersionToDraft({ draft, bytes: upload.bytes, source: "browser" });
  } catch (error) {
    console.error("uploadVersionAction failed", error);
    return { error: "Upload failed. Please try again." };
  }
  revalidatePath(`/dashboard/drafts/${draft.id}`);
  return null;
}

export async function setVisibilityAction(formData: FormData): Promise<void> {
  const { userId, draft } = await requireOwnedDraft(formData.get("draftId"));
  const visibility = visibilitySchema.safeParse(formData.get("visibility"));
  if (visibility.success && visibility.data !== draft.visibility) {
    await setDraftVisibility(draft, visibility.data, { userId });
  }
  revalidatePath(`/dashboard/drafts/${draft.id}`);
  revalidatePath("/dashboard");
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
      await restoreVersion({ draft, version, source: "browser" });
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
    console.error("createTokenAction failed", error);
    return { error: "Could not create the token. Please try again." };
  }
}

export async function revokeTokenAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const tokenId = uuidSchema.safeParse(formData.get("tokenId"));
  if (tokenId.success) {
    await revokeToken(user.id, tokenId.data);
  }
  revalidatePath("/dashboard/settings/tokens");
}
