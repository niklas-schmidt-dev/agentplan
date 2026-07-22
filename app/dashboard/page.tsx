import { SignOutButton } from "@/components/auth-buttons";
import { requireUser } from "@/lib/auth/session";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const user = await requireUser();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col gap-8 px-6 py-10">
      <header className="flex items-center justify-between">
        <span className="font-mono text-sm text-ink-muted">
          <span className="text-lime">agentplan</span> / dashboard
        </span>
        <div className="flex items-center gap-4">
          <span className="font-mono text-xs text-ink-faint">{user.email}</span>
          <SignOutButton />
        </div>
      </header>
      <section>
        <p className="text-ink-muted">No drafts yet.</p>
      </section>
    </main>
  );
}
