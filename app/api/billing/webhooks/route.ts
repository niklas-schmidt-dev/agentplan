import { validateEvent, WebhookVerificationError } from "@/lib/billing/webhooks";
import { readBillingConfig } from "@/lib/billing/config";
import { billingErrorSummary } from "@/lib/billing/errors";
import { clearSubscriptionForUser, syncUserFromProvider } from "@/lib/billing/service";

export const runtime = "nodejs";

const MAX_WEBHOOK_BYTES = 256 * 1024;

/**
 * Polar → AgentPlan. Every event that can change entitlements is reduced to
 * "re-read this customer's state", which is idempotent and order-independent:
 * a replayed or out-of-order delivery converges on the same row.
 */
export async function POST(req: Request): Promise<Response> {
  const config = readBillingConfig();
  if (!config) return Response.json({ error: "Billing is not configured." }, { status: 404 });

  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) {
    return Response.json({ error: "Payload too large." }, { status: 413 });
  }
  const body = await req.text();
  if (body.length > MAX_WEBHOOK_BYTES) {
    return Response.json({ error: "Payload too large." }, { status: 413 });
  }

  let event: ReturnType<typeof validateEvent>;
  try {
    event = validateEvent(
      body,
      {
        "webhook-id": req.headers.get("webhook-id") ?? "",
        "webhook-timestamp": req.headers.get("webhook-timestamp") ?? "",
        "webhook-signature": req.headers.get("webhook-signature") ?? "",
      },
      config.webhookSecret,
    );
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      console.warn("Polar webhook signature rejected", error.message);
      return Response.json({ error: "Invalid webhook signature." }, { status: 403 });
    }
    // Unknown or malformed event types are acknowledged so Polar stops
    // retrying; they carry nothing we act on.
    console.warn("Ignoring unparseable Polar webhook", billingErrorSummary(error));
    return Response.json({ received: true, ignored: true }, { status: 202 });
  }

  try {
    switch (event.type) {
      case "customer.state_changed": {
        // A redelivery can contain an older subscription snapshot.
        const userId = event.data.externalId?.trim();
        if (userId) await syncUserFromProvider(userId, config);
        return Response.json({ received: true, applied: Boolean(userId) });
      }
      case "customer.deleted": {
        const userId = event.data.externalId?.trim();
        if (userId) await clearSubscriptionForUser(userId);
        return Response.json({ received: true, applied: Boolean(userId) });
      }
      case "subscription.created":
      case "subscription.updated":
      case "subscription.active":
      case "subscription.canceled":
      case "subscription.uncanceled":
      case "subscription.revoked":
      case "subscription.past_due":
      case "subscription.cycled":
      case "subscription.paused":
      case "subscription.resumed":
      case "order.paid": {
        // The payload names the customer; the authoritative entitlement is
        // fetched rather than trusted from a possibly stale event body.
        const userId = event.data.customer.externalId?.trim();
        if (userId) await syncUserFromProvider(userId, config);
        return Response.json({ received: true, applied: Boolean(userId) });
      }
      default:
        return Response.json({ received: true, ignored: true });
    }
  } catch (error) {
    // 5xx makes Polar retry with backoff, which is what we want for transient
    // database or provider failures.
    console.error("Polar webhook processing failed", event.type, billingErrorSummary(error));
    return Response.json({ error: "Webhook processing failed." }, { status: 500 });
  }
}
