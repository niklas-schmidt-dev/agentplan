"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { deleteUserCompletely, setUserRole } from "@/lib/admin/service";
import { recordAuditEvent } from "@/lib/audit/events";
import { requireAdmin } from "@/lib/auth/session";
import { setSignupsEnabled } from "@/lib/settings/service";

const userIdSchema = z.string().min(1).max(255);
const roleSchema = z.enum(["user", "admin"]);

export async function setSignupsEnabledAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const enabled = formData.get("enabled") === "true";
  await setSignupsEnabled({ userId: admin.id }, enabled);
  await recordAuditEvent({
    type: "settings.signups_changed",
    userId: admin.id,
    metadata: { enabled },
  });
  revalidatePath("/dashboard/admin");
}

export async function setUserRoleAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const userId = userIdSchema.safeParse(formData.get("userId"));
  const role = roleSchema.safeParse(formData.get("role"));
  if (userId.success && role.success && userId.data !== admin.id) {
    await setUserRole({ userId: admin.id }, userId.data, role.data);
  }
  revalidatePath("/dashboard/admin");
}

export async function deleteUserAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const userId = userIdSchema.safeParse(formData.get("userId"));
  if (userId.success && userId.data !== admin.id) {
    // No error channel on this plain form action; a failed storage cleanup
    // leaves the row in place (deletion stays retryable) instead of a 500.
    try {
      await deleteUserCompletely({ userId: admin.id }, userId.data);
    } catch (error) {
      console.error("deleteUserAction failed", error);
    }
  }
  revalidatePath("/dashboard/admin");
}
