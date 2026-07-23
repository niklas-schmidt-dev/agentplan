"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  deleteUserCompletely,
  removeDraftAsAdmin,
  setUserPlan,
  setUserRole,
} from "@/lib/admin/service";
import { requireAdmin } from "@/lib/auth/session";
import { setSignupsEnabled } from "@/lib/settings/service";

const userIdSchema = z.string().min(1).max(255);
const draftIdSchema = z.uuid();
const planSchema = z.enum(["free", "unlimited"]);
const roleSchema = z.enum(["user", "admin"]);
export type AdminActionState = { error: string } | null;

export async function setSignupsEnabledAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const enabled = formData.get("enabled") === "true";
  try {
    await setSignupsEnabled({ userId: admin.id }, enabled);
  } catch (error) {
    console.error("setSignupsEnabledAction failed", error);
    return { error: "Signup setting change failed. Refresh and try again." };
  }
  revalidatePath("/dashboard/admin");
  return null;
}

export async function setUserRoleAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const userId = userIdSchema.safeParse(formData.get("userId"));
  const role = roleSchema.safeParse(formData.get("role"));
  if (!userId.success || !role.success || userId.data === admin.id) {
    return { error: "Invalid role change request." };
  }
  try {
    await setUserRole({ userId: admin.id }, userId.data, role.data);
  } catch (error) {
    console.error("setUserRoleAction failed", error);
    return { error: "Role change failed. Refresh and try again." };
  }
  revalidatePath("/dashboard/admin");
  return null;
}

export async function setUserPlanAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const userId = userIdSchema.safeParse(formData.get("userId"));
  const plan = planSchema.safeParse(formData.get("plan"));
  if (!userId.success || !plan.success) {
    return { error: "Invalid plan change request." };
  }
  try {
    await setUserPlan({ userId: admin.id }, userId.data, plan.data);
  } catch (error) {
    console.error("setUserPlanAction failed", error);
    return { error: "Plan change failed. Refresh and try again." };
  }
  revalidatePath("/dashboard/admin");
  revalidatePath("/dashboard");
  return null;
}

export async function removeDraftAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const draftId = draftIdSchema.safeParse(formData.get("draftId"));
  if (!draftId.success) {
    return { error: "Invalid content removal request." };
  }
  try {
    const removed = await removeDraftAsAdmin({ userId: admin.id }, draftId.data);
    if (removed) {
      revalidatePath(`/p/${removed.slug}`);
    }
  } catch (error) {
    console.error("removeDraftAction failed", error);
    return { error: "Content removal failed. Refresh and try again." };
  }
  revalidatePath("/dashboard/admin");
  revalidatePath("/dashboard/admin/content");
  revalidatePath("/dashboard");
  return null;
}

export async function deleteUserAction(
  _previousState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const userId = userIdSchema.safeParse(formData.get("userId"));
  if (!userId.success || userId.data === admin.id) {
    return { error: "Invalid user deletion request." };
  }
  try {
    await deleteUserCompletely({ userId: admin.id }, userId.data);
  } catch (error) {
    console.error("deleteUserAction failed", error);
    return { error: "Deletion failed. No account changes were committed." };
  }
  revalidatePath("/dashboard/admin");
  revalidatePath("/dashboard/admin/content");
  return null;
}
