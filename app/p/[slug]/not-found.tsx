import Link from "next/link";
import { SignInToViewLink } from "@/components/sign-in-to-view-link";
import { getOptionalUser } from "@/lib/auth/session";

/**
 * One 404 for every unavailable viewer URL — missing, deleted, expired, or
 * private. The sign-in hint depends only on the visitor's own session, never
 * on the draft, so the page reveals nothing about what exists at the URL.
 */
export default async function DraftNotFound() {
  const user = await getOptionalUser();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-edge bg-surface p-6">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-xs text-ink-faint">
            <span className="text-lime">agentplan</span>.app
          </span>
          <h1 className="text-lg font-semibold text-ink">404</h1>
          <p className="text-sm text-ink-muted">This page could not be found.</p>
          {user ? null : (
            <p className="text-sm text-ink-muted">You’re not signed in — that may be why.</p>
          )}
        </div>
        {user ? (
          <Link
            href="/dashboard"
            className="w-fit font-mono text-xs text-ink-muted transition-colors hover:text-lime"
          >
            go to dashboard →
          </Link>
        ) : (
          <SignInToViewLink />
        )}
      </div>
    </main>
  );
}
