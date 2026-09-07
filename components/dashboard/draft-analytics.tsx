import { ViewSparkline } from "./view-sparkline";
import { getDraftViewStats } from "@/lib/analytics/queries";

export async function DraftAnalytics({
  draftId,
  versionId,
  versionNumber,
}: {
  draftId: string;
  versionId?: string;
  versionNumber?: number;
}) {
  const views = await getDraftViewStats(draftId, versionId).catch(() => null);
  if (!views)
    return (
      <p role="status" className="font-mono text-xs text-ink-faint">
        Analytics are temporarily unavailable.
      </p>
    );
  return (
    <section className="flex flex-col gap-3" aria-label="View analytics">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-mono text-sm text-ink-muted">
          analytics{versionNumber ? ` · v${versionNumber}` : ""}
        </h2>
        <p className="font-mono text-xs text-ink-faint">excludes your views</p>
      </div>

      <dl className="grid grid-cols-2 gap-4 rounded-md border border-edge bg-surface p-4 sm:grid-cols-5">
        {[
          ["views · 24h", views.last24h],
          ["views · 7d", views.last7d],
          ["views · 30d", views.last30d],
          ["views · total", views.total],
          ["daily uniques · 30d", views.visitors30d],
        ].map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1">
            <dt className="font-mono text-xs text-ink-muted">{label}</dt>
            <dd className="text-2xl font-semibold tabular-nums text-ink">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-4 rounded-md border border-edge bg-surface p-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <h3 className="font-mono text-xs text-ink-muted">daily views · 30d</h3>
          <ViewSparkline days={views.byDay} />
        </div>
        <div className="grid grid-cols-2 gap-4 font-mono text-xs">
          <div className="flex flex-col gap-1.5">
            <h3 className="text-ink-muted">referrers · 30d</h3>
            {views.topReferrers30d.length === 0 ? (
              <p className="text-ink-faint">direct / none yet</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {views.topReferrers30d.map((referrer) => (
                  <li key={referrer.host} className="flex justify-between gap-2">
                    <span className="truncate text-ink">{referrer.host}</span>
                    <span className="tabular-nums text-ink-muted">{referrer.views}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <h3 className="text-ink-muted">countries · 30d</h3>
            {views.topCountries30d.length === 0 ? (
              <p className="text-ink-faint">none yet</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {views.topCountries30d.map((entry) => (
                  <li key={entry.country} className="flex justify-between gap-2">
                    <span className="text-ink">{entry.country}</span>
                    <span className="tabular-nums text-ink-muted">{entry.views}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="col-span-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-edge pt-3 text-ink-faint">
            <span>
              anonymous:{" "}
              <span className="tabular-nums text-ink-muted">
                {views.viewerBreakdown30d.anonymous}
              </span>
            </span>
            <span>
              signed-in:{" "}
              <span className="tabular-nums text-ink-muted">{views.viewerBreakdown30d.user}</span>
            </span>
            <span>
              you:{" "}
              <span className="tabular-nums text-ink-muted">{views.viewerBreakdown30d.owner}</span>
            </span>
            <span>(30d)</span>
          </div>
        </div>
      </div>
    </section>
  );
}
