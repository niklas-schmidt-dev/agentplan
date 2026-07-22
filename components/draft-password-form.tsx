import { submitDraftPassword } from "@/app/p/[slug]/actions";

export function DraftPasswordForm({ slug, error }: { slug: string; error?: boolean }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-edge bg-surface p-6">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-xs text-ink-faint">
            <span className="text-lime">agentplan</span>.app
          </span>
          <h1 className="text-lg font-semibold text-ink">This document is password-protected</h1>
          <p className="text-sm text-ink-muted">Enter the password to view it.</p>
        </div>
        <form action={submitDraftPassword} className="flex flex-col gap-3">
          <input type="hidden" name="slug" value={slug} />
          <input
            type="password"
            name="password"
            required
            autoFocus
            aria-label="Password"
            aria-invalid={error ? true : undefined}
            className="rounded border border-edge bg-canvas px-3 py-2 font-mono text-sm text-ink placeholder:text-ink-faint"
            placeholder="password"
          />
          {error ? (
            <p role="alert" className="font-mono text-xs text-danger">
              Incorrect password. Try again.
            </p>
          ) : null}
          <button
            type="submit"
            className="rounded-md bg-lime px-4 py-2 font-mono text-sm font-medium text-canvas transition-colors hover:bg-lime-dim"
          >
            unlock
          </button>
        </form>
      </div>
    </main>
  );
}
