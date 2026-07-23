"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { deleteUserCompletely, setUserRole } from "@/lib/admin/service";
import { requireAdmin } from "@/lib/auth/session";
import { setSignupsEnabled } from "@/lib/settings/service";

const userIdSchema = z.string().min(1).max(255);
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
    return { error: "Deletion failed. The user and database rows were kept." };
  }
  revalidatePath("/dashboard/admin");
  return null;
}
