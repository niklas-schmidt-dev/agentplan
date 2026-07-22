import Link from "next/link";
import { SignOutButton } from "@/components/auth-buttons";

export function DashboardHeader({ email }: { email: string }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-edge pb-4">
      <nav className="flex items-center gap-4 font-mono text-sm">
        <Link href="/dashboard" className="text-ink-muted transition-colors hover:text-lime">
          <span className="text-lime">agentplan</span> / dashboard
        </Link>
        <Link
          href="/dashboard/settings/tokens"
          className="text-ink-muted transition-colors hover:text-lime"
        >
          tokens
        </Link>
      </nav>
      <div className="flex items-center gap-4">
        <span className="font-mono text-xs text-ink-faint">{email}</span>
        <SignOutButton />
      </div>
    </header>
  );
}
