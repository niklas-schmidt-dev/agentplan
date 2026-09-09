import Link from "next/link";

/**
 * Shown where a Free limit stops an action. It names the limit, keeps the
 * user's data promise explicit, and offers the paid path once. No modal: the
 * user stays on the page they were working on.
 */
export function UpgradePrompt({
  title = "Free plan limit reached",
  message,
  href,
  alternative,
}: {
  title?: string;
  message: string;
  href: string;
  alternative?: string;
}) {
  return (
    <aside
      role="alert"
      className="rise flex w-full flex-col gap-3 border-l-2 border-lime bg-surface px-4 py-3"
    >
      <p className="font-mono text-xs uppercase tracking-[0.16em] text-lime">{title}</p>
      <p className="text-sm leading-6 text-ink-muted">{message}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link
          href={href}
          className="rounded-md border border-lime bg-lime px-3 py-1.5 font-mono text-xs font-medium text-canvas transition-colors hover:bg-lime-dim"
        >
          see pro →
        </Link>
        {alternative ? (
          <span className="font-mono text-xs text-ink-faint">{alternative}</span>
        ) : null}
      </div>
    </aside>
  );
}
