import Link from "next/link";
import { GITHUB_FORK_URL, VERCEL_DEPLOY_URL, VERCEL_IMPORT_URL } from "@/lib/deploy";

export const metadata = {
  title: "Self-host",
  description: "Deploy your own AgentPlan with Vercel, Neon, and private Vercel Blob.",
};

const services = [
  {
    index: "01",
    name: "Neon Postgres",
    detail:
      "Project data, auth, limits, and audit history. Provisioned and connected automatically.",
  },
  {
    index: "02",
    name: "Private Vercel Blob",
    detail:
      "Uploaded HTML stays private and is released only through AgentPlan's authorization layer.",
  },
  {
    index: "03",
    name: "AgentPlan",
    detail:
      "Migrations run on the first production build. Email/password is ready without another provider.",
  },
];

export default function SelfHostPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col px-6 py-10 sm:py-16">
      <header className="flex items-center justify-between">
        <Link
          href="/"
          className="font-mono text-sm text-ink-muted transition-colors hover:text-lime"
        >
          <span className="text-lime">agentplan</span>.app
        </Link>
        <span className="font-mono text-xs uppercase tracking-[0.22em] text-ink-faint">
          self-host manifest
        </span>
      </header>

      <section className="grid flex-1 items-center gap-12 py-16 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="flex flex-col items-start gap-7">
          <div className="flex items-center gap-3 font-mono text-xs uppercase tracking-[0.2em] text-lime">
            <span className="h-px w-8 bg-lime" />
            your infrastructure
          </div>
          <h1 className="max-w-2xl text-4xl font-semibold tracking-[-0.04em] text-ink sm:text-6xl">
            One deploy.
            <br />
            Your own AgentPlan.
          </h1>
          <p className="max-w-xl text-base leading-7 text-ink-muted">
            Vercel creates the project, connects a Neon database, and provisions Blob storage. You
            keep the repository, the data, and the deployment.
          </p>
          <div className="flex max-w-xl flex-col items-start gap-3 sm:flex-row sm:items-center">
            <a
              href={VERCEL_DEPLOY_URL}
              className="group inline-flex shrink-0 items-center gap-3 rounded-md border border-ink bg-ink px-5 py-3 font-mono text-sm font-medium text-canvas transition-colors hover:border-lime hover:bg-lime"
            >
              Deploy with Vercel
              <span aria-hidden="true" className="transition-transform group-hover:translate-x-1">
                →
              </span>
            </a>
            <span className="font-mono text-xs leading-5 text-ink-faint">
              Creates a standalone repository,
              <br className="hidden sm:block" /> not a GitHub fork.
            </span>
          </div>
          <aside
            aria-label="Upstream-linked deployment"
            className="max-w-xl border-l-2 border-lime bg-surface px-4 py-3"
          >
            <p className="font-mono text-xs uppercase tracking-[0.16em] text-lime">
              Want GitHub&apos;s Sync fork?
            </p>
            <p className="mt-2 text-sm leading-6 text-ink-muted">
              Fork AgentPlan on GitHub, then import that fork into Vercel. Add Neon, a private Blob
              store, and the same three required values before the final production redeploy.
            </p>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 font-mono text-xs">
              <a href={GITHUB_FORK_URL} className="text-ink transition-colors hover:text-lime">
                1. Fork on GitHub →
              </a>
              <a href={VERCEL_IMPORT_URL} className="text-ink transition-colors hover:text-lime">
                2. Import into Vercel →
              </a>
            </div>
            <p className="mt-3 font-mono text-[11px] leading-5 text-ink-faint">
              GitHub forks of this public repository are public. Use the one-click path above when
              the deployment repository must be private.
            </p>
          </aside>
          <p className="max-w-lg font-mono text-xs leading-5 text-ink-faint">
            In the Blob step, choose <strong className="font-medium text-ink-muted">Private</strong>
            . The deploy flow asks for three must-have values. Resend adds verification and password
            recovery; GitHub adds another sign-in option. Both are optional.
          </p>
        </div>

        <ol className="border-y border-edge">
          {services.map((service) => (
            <li
              key={service.index}
              className="grid grid-cols-[2.5rem_1fr] gap-4 border-b border-edge py-6 last:border-b-0"
            >
              <span className="font-mono text-xs text-lime">{service.index}</span>
              <div className="flex flex-col gap-2">
                <h2 className="font-mono text-sm text-ink">{service.name}</h2>
                <p className="text-sm leading-6 text-ink-muted">{service.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <footer className="flex flex-col gap-3 border-t border-edge pt-6 font-mono text-xs text-ink-faint sm:flex-row sm:items-center sm:justify-between">
        <span>MIT licensed · bring your own domain</span>
        <a
          href="https://github.com/niklas-schmidt-dev/agentplan/blob/main/docs/self-hosting.md"
          className="transition-colors hover:text-lime"
        >
          manual setup and R2 options →
        </a>
      </footer>
    </main>
  );
}
