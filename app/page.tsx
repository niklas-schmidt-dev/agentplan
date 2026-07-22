import Link from "next/link";

export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col justify-center gap-10 px-6 py-16">
      <header className="flex items-center justify-between">
        <span className="font-mono text-sm text-ink-muted">
          <span className="text-lime">agentplan</span>.app
        </span>
        <Link
          href="/dashboard"
          className="font-mono text-sm text-ink-muted transition-colors hover:text-lime"
        >
          dashboard →
        </Link>
      </header>

      <section className="flex flex-col gap-6">
        <h1 className="text-4xl font-semibold tracking-tight text-ink">
          Stable links for agent-generated HTML.
        </h1>
        <p className="max-w-xl text-lg text-ink-muted">
          Your agent writes a plan, a report, a dashboard. AgentPlan gives it a URL — private by
          default, versioned forever, sandboxed always.
        </p>
        <pre className="w-fit rounded-md border border-edge bg-surface px-4 py-3 font-mono text-sm text-ink">
          <span className="text-ink-faint">$ </span>
          <span className="text-lime">npx agentplan</span> upload ./plan.html
        </pre>
      </section>

      <footer className="font-mono text-xs text-ink-faint">
        MIT licensed ·{" "}
        <a
          href="https://github.com/niklas-schmidt-dev/agentplan"
          className="underline decoration-ink-faint underline-offset-2 transition-colors hover:text-lime"
        >
          github
        </a>
      </footer>
    </main>
  );
}
