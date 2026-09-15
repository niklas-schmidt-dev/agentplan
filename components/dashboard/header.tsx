import Link from "next/link";
import { SignOutButton } from "@/components/auth-buttons";

export function DashboardHeader({
  email,
  isAdmin = false,
  billingEnabled = false,
}: {
  email: string;
  isAdmin?: boolean;
  billingEnabled?: boolean;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-edge pb-4">
      <nav className="flex flex-wrap items-center gap-4 font-mono text-sm">
        <Link href="/dashboard" className="text-ink-muted transition-colors hover:text-lime">
          <span className="text-lime">agentplan</span> / dashboard
        </Link>
        <Link
          href="/dashboard/settings/tokens"
          className="text-ink-muted transition-colors hover:text-lime"
        >
          tokens
        </Link>
        {billingEnabled ? (
          <Link
            href="/dashboard/billing"
            className="text-ink-muted transition-colors hover:text-lime"
          >
            plan
          </Link>
        ) : null}
        {isAdmin ? (
          <Link
            href="/dashboard/admin"
            className="text-ink-muted transition-colors hover:text-lime"
          >
            admin
          </Link>
        ) : null}
      </nav>
      <div className="flex min-w-0 max-w-full items-center gap-4 [&>button]:shrink-0">
        <span title={email} className="min-w-0 truncate font-mono text-xs text-ink-faint">
          {email}
        </span>
        <SignOutButton />
      </div>
    </header>
  );
}
