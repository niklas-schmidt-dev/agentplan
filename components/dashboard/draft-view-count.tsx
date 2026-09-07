import type { DraftViewCounts } from "@/lib/analytics/queries";

export async function DraftViewCount({
  counts,
  draftId,
}: {
  counts: Promise<Map<string, DraftViewCounts> | null>;
  draftId: string;
}) {
  const result = await counts;
  if (!result) return <span>views unavailable</span>;
  const views = result.get(draftId);
  if (!views?.total) return <span>no views yet</span>;
  return (
    <span>
      {views.total} {views.total === 1 ? "view" : "views"}
      {views.last7d > 0 ? ` (${views.last7d} this week)` : ""}
    </span>
  );
}
