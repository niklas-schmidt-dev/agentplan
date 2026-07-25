import { Resend } from "resend";

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

function resendApiKey(): string | undefined {
  return process.env.RESEND_API_KEY?.trim() || undefined;
}

function resendSender(): string | undefined {
  return process.env.AUTH_EMAIL_FROM?.trim() || undefined;
}

function webhookEndpoint(): string | undefined {
  return process.env.AUTH_EMAIL_WEBHOOK_URL?.trim() || undefined;
}

/**
 * Reports whether verification and password-recovery messages can be
 * delivered. Email/password authentication itself does not depend on this.
 */
export function isEmailDeliveryConfigured(): boolean {
  if (resendApiKey() && resendSender()) return true;
  return Boolean(
    webhookEndpoint() &&
      (process.env.AUTH_EMAIL_WEBHOOK_SECRET?.trim() || process.env.NODE_ENV !== "production"),
  );
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      (
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }) as const
      )[character as "&" | "<" | ">" | '"' | "'"],
  );
}

function emailContent(message: AuthEmail): { subject: string; text: string; html: string } {
  const verification = message.kind === "verify_email";
  const subject = verification ? "Verify your AgentPlan email" : "Reset your AgentPlan password";
  const action = verification ? "verify your email address" : "reset your password";
  const button = verification ? "Verify email" : "Reset password";
  const greeting = message.name.trim() ? `Hi ${message.name.trim()},` : "Hi,";
  const safeGreeting = escapeHtml(greeting);
  const safeUrl = escapeHtml(message.url);

  return {
    subject,
    text: `${greeting}\n\nUse this link to ${action}:\n${message.url}\n\nIf you did not request this, you can ignore this email.`,
    html: `<div style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;line-height:1.6;color:#171717">
  <p>${safeGreeting}</p>
  <p>Use the button below to ${action}.</p>
  <p><a href="${safeUrl}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#171717;color:#fff;text-decoration:none">${button}</a></p>
  <p style="font-size:12px;color:#737373">If you did not request this, you can ignore this email.</p>
</div>`,
  };
}

async function sendWithResend(message: AuthEmail, apiKey: string): Promise<void> {
  const from = resendSender();
  if (!from) {
    throw new Error("AUTH_EMAIL_FROM is required when RESEND_API_KEY is configured");
  }

  const { error } = await new Resend(apiKey).emails.send({
    from,
    to: message.to,
    ...emailContent(message),
  });
  if (error) {
    throw new Error("Resend auth email delivery failed");
  }
}

/**
 * Sends auth mail through Resend when configured, otherwise through a
 * deployment-owned HTTPS webhook. Verification/reset tokens are never logged.
 * Callers only enable verification and recovery when delivery is complete.
 */
export async function sendAuthEmail(message: AuthEmail): Promise<void> {
  const apiKey = resendApiKey();
  if (apiKey && resendSender()) {
    await sendWithResend(message, apiKey);
    return;
  }

  const endpointValue = webhookEndpoint();
  if (!endpointValue) {
    if (apiKey) {
      throw new Error("AUTH_EMAIL_FROM is required when RESEND_API_KEY is configured");
    }
    if (process.env.NODE_ENV !== "production") return;
    throw new Error("Email delivery is not configured");
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
