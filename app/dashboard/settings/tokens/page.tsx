import { revokeTokenAction } from "@/app/dashboard/actions";
import { DangerButton } from "@/components/dashboard/danger-button";
import { DashboardHeader } from "@/components/dashboard/header";
import { TokenCreatePanel } from "@/components/dashboard/token-create-panel";
import { requireUser } from "@/lib/auth/session";
import { formatRelativeTime } from "@/lib/format";
import { listTokensForUser } from "@/lib/tokens/service";

export const metadata = { title: "API tokens" };

export default async function TokensPage() {
  const user = await requireUser();
  const tokens = await listTokensForUser(user.id);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <DashboardHeader email={user.email} />

      <section className="flex flex-col gap-3">
        <h1 className="font-mono text-sm text-ink-muted">api tokens</h1>
        <p className="text-sm text-ink-muted">
          Tokens authenticate agents and the CLI:{" "}
          <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs text-lime">
            Authorization: Bearer ap_live_…
          </code>
        </p>
        <TokenCreatePanel />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-sm text-ink-muted">active tokens</h2>
        {tokens.length === 0 ? (
          <p className="font-mono text-sm text-ink-faint">No active tokens.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-edge rounded-md border border-edge bg-surface">
            {tokens.map((token) => (
              <li
                key={token.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 font-mono text-xs"
              >
                <span className="text-ink">{token.name}</span>
                <code className="text-ink-muted">{token.tokenPrefix}…</code>
                <span className="text-ink-faint">{token.scopes.join(", ")}</span>
                <span className="text-ink-faint">
                  {token.lastUsedAt
                    ? `last used ${formatRelativeTime(token.lastUsedAt)}`
                    : "never used"}
                </span>
                {token.expiresAt ? (
                  <span className="text-ink-faint">
                    expires {formatRelativeTime(token.expiresAt)}
                  </span>
                ) : null}
                <form action={revokeTokenAction} className="ml-auto">
                  <input type="hidden" name="tokenId" value={token.id} />
                  <DangerButton label="revoke" confirmLabel="confirm revoke" />
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
