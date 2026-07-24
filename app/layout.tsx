import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "./globals.css";

// The proxy supplies a fresh CSP nonce through the request headers. Rendering
// every route per request lets Next.js attach that nonce to its framework
// scripts; statically generated pages cannot receive a request-specific nonce.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: {
    default: "AgentPlan",
    template: "%s — AgentPlan",
  },
  description: "Publish agent-generated HTML behind stable links.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-dvh bg-canvas text-ink">{children}</body>
    </html>
  );
}
