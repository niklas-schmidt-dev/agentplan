import { StatTile } from "./stat-tile";
import { ViewSparkline } from "./view-sparkline";
import { getDraftViewStats } from "@/lib/analytics/queries";

export async function DraftAnalytics({ draftId }: { draftId: string }) {
  const views = await getDraftViewStats(draftId).catch(() => null);
  if (!views)
    return (
      <p role="status" className="font-mono text-xs text-ink-faint">
        Analytics are temporarily unavailable.
      </p>
    );
  return (
    <section className="flex flex-col gap-3" aria-label="View analytics">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-mono text-sm text-ink-muted">analytics</h2>
        <p className="font-mono text-xs text-ink-faint">
          your own views are excluded
          {views.viewerBreakdown30d.owner > 0
            ? ` (${views.viewerBreakdown30d.owner} in the last 30 days)`
            : ""}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatTile label="views (24h)" value={String(views.last24h)} />
        <StatTile label="views (7d)" value={String(views.last7d)} />
        <StatTile label="views (30d)" value={String(views.last30d)} />
        <StatTile label="views (total)" value={String(views.total)} />
        <StatTile label="visitors (30d)" value={String(views.visitors30d)} detail="daily uniques" />
      </div>

      <div className="grid gap-4 rounded-md border border-edge bg-surface p-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <h3 className="font-mono text-xs text-ink-muted">daily views · last 30 days</h3>
          <ViewSparkline days={views.byDay} />
        </div>
        <div className="grid grid-cols-2 gap-4 font-mono text-xs">
          <div className="flex flex-col gap-1.5">
            <h3 className="text-ink-muted">top referrers (30d)</h3>
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
            <h3 className="text-ink-muted">top countries (30d)</h3>
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
