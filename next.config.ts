import type { NextConfig } from "next";

// Viewer shell: strict CSP. The uploaded document itself is isolated by the
// iframe sandbox plus the content route's own CSP sandbox response header.
const VIEWER_SHELL_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  experimental: {
    serverActions: {
      // Default is 1 MB, which would reject dashboard uploads below the 2 MiB
      // file limit; 3mb covers the file plus multipart framing.
      bodySizeLimit: "3mb",
    },
  },
  async headers() {
    return [
      {
        // Everything except /p/* — the viewer shell and content route manage
        // their own headers and must not inherit conflicting ones.
        source: "/((?!p/).*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      {
        source: "/p/:slug",
        headers: [
          { key: "Content-Security-Policy", value: VIEWER_SHELL_CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
