export const HTML_SANDBOX = "sandbox allow-scripts allow-forms allow-modals allow-popups";
export const MEDIA_SANDBOX = "sandbox";

export function contentHeaders(contentSecurityPolicy: string): Headers {
  return new Headers({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": `${contentSecurityPolicy}; frame-ancestors 'self'`,
    "X-Robots-Tag": "noindex",
  });
}

export function contentNotFound(): Response {
  const headers = contentHeaders(MEDIA_SANDBOX);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "private, no-store");
  return new Response("Not found", { status: 404, headers });
}
