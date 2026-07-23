import Link from "next/link";

export const metadata = { title: "Security" };

export default function SecurityPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col justify-center gap-8 px-6 py-16">
      <Link href="/" className="font-mono text-sm text-ink-muted transition-colors hover:text-lime">
        <span className="text-lime">agentplan</span>.app
      </Link>
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Security</h1>
        <p className="text-sm leading-6 text-ink-muted">
          Please report vulnerabilities privately through the repository&apos;s GitHub Security
          Advisories page. Do not include credentials or private user content in a report.
        </p>
        <a
          href="https://github.com/niklas-schmidt-dev/agentplan/security/advisories/new"
          className="font-mono text-sm text-lime hover:text-lime-dim"
        >
          submit a private security advisory →
        </a>
      </div>
    </main>
  );
}
