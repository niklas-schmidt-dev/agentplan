import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    `connect-src 'self'${process.env.NODE_ENV === "development" ? " ws:" : ""}`,
    "frame-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/**
 * A fresh nonce is passed to Next.js through the request CSP header so its
 * framework scripts receive the same nonce. The hostile HTML content route is
 * intentionally excluded because its response owns a CSP `sandbox` policy.
 */
export function proxy(request: NextRequest) {
  if (/^\/p\/[^/]+\/content\/?$/.test(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const nonce = randomBytes(16).toString("base64");
  const policy = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", policy);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
