"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { isBillingConfigured, readBillingConfig } from "@/lib/billing/config";
import { billingErrorSummary } from "@/lib/billing/errors";
import { createCheckoutUrl, createPortalUrl, syncUserFromProvider } from "@/lib/billing/service";

export type BillingActionState = { error: string } | null;

const productIdSchema = z.string().trim().min(1).max(255);

export async function startCheckoutAction(
  _previousState: BillingActionState,
  formData: FormData,
): Promise<BillingActionState> {
  const user = await requireUser();
  const config = readBillingConfig();
  if (!config) return { error: "Billing is not available on this deployment." };
  const parsed = productIdSchema.safeParse(formData.get("productId"));
  const productId =
    parsed.success && config.productIds.includes(parsed.data) ? parsed.data : undefined;
  let url: string;
  try {
    url = await createCheckoutUrl(
      { userId: user.id, email: user.email, name: user.name },
      productId,
      config,
    );
  } catch (error) {
    console.error("startCheckoutAction failed", billingErrorSummary(error));
    return { error: "Checkout could not be started. Please try again." };
  }
  redirect(url);
}

export async function openPortalAction(): Promise<BillingActionState> {
  const user = await requireUser();
  if (!isBillingConfigured()) return { error: "Billing is not available on this deployment." };
  let url: string | null;
  try {
    url = await createPortalUrl(user.id);
  } catch (error) {
    console.error("openPortalAction failed", billingErrorSummary(error));
    return { error: "The billing portal could not be opened. Please try again." };
  }
  if (!url) return { error: "No billing account exists for this user yet." };
  redirect(url);
}

/** Manual refresh after returning from checkout, in case the webhook is late. */
export async function refreshSubscriptionAction(): Promise<BillingActionState> {
  const user = await requireUser();
  if (!isBillingConfigured()) return null;
  try {
    await syncUserFromProvider(user.id);
  } catch (error) {
    console.error("refreshSubscriptionAction failed", billingErrorSummary(error));
    return { error: "Subscription status could not be refreshed. Please try again." };
  }
  revalidatePath("/dashboard/billing");
  revalidatePath("/dashboard");
  return null;
}
