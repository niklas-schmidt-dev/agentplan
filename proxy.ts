import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

type PolicyEnvironment = {
  NODE_ENV?: string;
  STORAGE_DRIVER?: string;
  BLOB_READ_WRITE_TOKEN?: string;
  BLOB_STORE_ID?: string;
  R2_ACCOUNT_ID?: string;
};

function directUploadConnectSources(environment: PolicyEnvironment): string[] {
  const configured = environment.STORAGE_DRIVER?.trim().toLowerCase();
  const driver =
    configured === "blob"
      ? "vercel-blob"
      : configured === "fs" || configured === "r2" || configured === "vercel-blob"
        ? configured
        : !configured && (environment.BLOB_READ_WRITE_TOKEN || environment.BLOB_STORE_ID)
          ? "vercel-blob"
          : !configured
            ? "r2"
            : null;

  if (driver === "vercel-blob") {
    // presignUrl() sends browser PUTs to Vercel Blob's control-plane host.
    return ["https://blob.vercel-storage.com"];
  }

  const accountId = environment.R2_ACCOUNT_ID?.trim();
  if (driver === "r2" && accountId && /^[a-f0-9]{32}$/i.test(accountId)) {
    return [`https://${accountId.toLowerCase()}.r2.cloudflarestorage.com`];
  }

  return [];
}

export function contentSecurityPolicy(
  nonce: string,
  environment: PolicyEnvironment = process.env,
): string {
  const connectSources = [
    "'self'",
    ...directUploadConnectSources(environment),
    ...(environment.NODE_ENV === "development" ? ["ws:"] : []),
  ];
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${environment.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "media-src 'self'",
    "font-src 'self'",
    `connect-src ${connectSources.join(" ")}`,
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
  if (
    /^\/p\/[^/]+\/content\/?$/.test(request.nextUrl.pathname) ||
    /^\/p\/[^/]+\/v\/[^/]+\/.+/.test(request.nextUrl.pathname)
  ) {
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
