import { Webhook, WebhookVerificationError } from "standardwebhooks";
import { WebhookCustomerStateChangedPayload$inboundSchema } from "@polar-sh/sdk/models/components/webhookcustomerstatechangedpayload.js";
import { WebhookCustomerDeletedPayload$inboundSchema } from "@polar-sh/sdk/models/components/webhookcustomerdeletedpayload.js";
import { z } from "zod";

export { WebhookVerificationError };

// These events only identify the customer whose current state we fetch.
const subscriptionEvent = z.object({
  type: z.enum([
    "subscription.created",
    "subscription.updated",
    "subscription.active",
    "subscription.canceled",
    "subscription.uncanceled",
    "subscription.revoked",
    "subscription.past_due",
    "subscription.cycled",
    "subscription.paused",
    "subscription.resumed",
    "order.paid",
  ]),
  data: z.object({
    customer: z
      .object({ external_id: z.string().nullable() })
      .transform((customer) => ({ externalId: customer.external_id })),
  }),
});

/**
 * Polar secrets created from 2026-09-08 use Standard Webhooks keys. Earlier
 * secrets use the UTF-8 bytes of the entire secret. SDK 0.49 only verifies the
 * latter; keep its payload schemas and use the standard library for both keys.
 * https://polar.sh/docs/integrate/webhooks/delivery
 */
export function validateEvent(body: string, headers: Record<string, string>, secret: string) {
  let payload: unknown;
  try {
    payload = new Webhook(Buffer.from(secret, "utf8").toString("base64")).verify(body, headers);
  } catch (error) {
    if (!(error instanceof WebhookVerificationError)) throw error;
    try {
      payload = new Webhook(secret).verify(body, headers);
    } catch {
      // Preserve a verification error even if a legacy secret cannot be decoded.
      throw error;
    }
  }
  const { type } = z.object({ type: z.string() }).parse(payload);
  if (type === "customer.state_changed") {
    return WebhookCustomerStateChangedPayload$inboundSchema.parse(payload);
  }
  if (type === "customer.deleted") {
    return WebhookCustomerDeletedPayload$inboundSchema.parse(payload);
  }
  return subscriptionEvent.parse(payload);
}
