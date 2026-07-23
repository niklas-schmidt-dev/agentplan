type AuthEmailKind = "verify_email" | "reset_password";

type AuthEmail = {
  kind: AuthEmailKind;
  to: string;
  name: string;
  url: string;
};

function isSafeDeliveryEndpoint(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return (
    process.env.NODE_ENV !== "production" &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1")
  );
}

/**
 * Sends auth mail through a deployment-owned HTTPS webhook. No provider SDK is
 * required and verification/reset tokens are never logged. Development and
 * tests may omit the webhook; production fails closed.
 */
export async function sendAuthEmail(message: AuthEmail): Promise<void> {
  const endpointValue = process.env.AUTH_EMAIL_WEBHOOK_URL?.trim();
  if (!endpointValue) {
    if (process.env.NODE_ENV !== "production") return;
    throw new Error("AUTH_EMAIL_WEBHOOK_URL is required in production");
  }

  const endpoint = new URL(endpointValue);
  if (!isSafeDeliveryEndpoint(endpoint)) {
    throw new Error("AUTH_EMAIL_WEBHOOK_URL must use HTTPS");
  }

  const secret = process.env.AUTH_EMAIL_WEBHOOK_SECRET?.trim();
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("AUTH_EMAIL_WEBHOOK_SECRET is required in production");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: {
      "content-type": "application/json",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify({
      ...message,
      from: process.env.AUTH_EMAIL_FROM?.trim() || "AgentPlan",
    }),
  });
  if (!response.ok) {
    throw new Error(`Auth email delivery failed with status ${response.status}`);
  }
}
