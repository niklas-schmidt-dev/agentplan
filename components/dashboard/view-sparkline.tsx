import type { DailyViews } from "@/lib/analytics/queries";

const BAR_WIDTH = 8;
const BAR_GAP = 2;
const PLOT_HEIGHT = 48;

/**
 * Server-rendered daily-views column chart. Native SVG `<title>` elements
 * provide the per-bar tooltip; the stat tiles beside it carry the numbers, so
 * the chart itself stays label-free.
 */
export function ViewSparkline({ days }: { days: DailyViews[] }) {
  if (days.length === 0) return null;
  const max = Math.max(1, ...days.map((day) => day.views));
  const width = days.length * (BAR_WIDTH + BAR_GAP) - BAR_GAP;
  const total = days.reduce((sum, day) => sum + day.views, 0);

  return (
    <figure className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${width} ${PLOT_HEIGHT}`}
        role="img"
        aria-label={`Daily views, last ${days.length} days: ${total} total, peak ${max} per day`}
        className="h-16 w-full max-w-md"
        preserveAspectRatio="none"
      >
        {days.map((day, index) => {
          const barHeight = Math.max(day.views > 0 ? 3 : 1.5, (day.views / max) * PLOT_HEIGHT);
          return (
            <rect
              key={day.day}
              x={index * (BAR_WIDTH + BAR_GAP)}
              y={PLOT_HEIGHT - barHeight}
              width={BAR_WIDTH}
              height={barHeight}
              rx={1.5}
              className={day.views > 0 ? "fill-lime hover:fill-lime-dim" : "fill-edge"}
            >
              <title>
                {`${day.day}: ${day.views} ${day.views === 1 ? "view" : "views"}, ${day.visitors} ${day.visitors === 1 ? "visitor" : "visitors"}`}
              </title>
            </rect>
          );
        })}
      </svg>
      <figcaption className="flex max-w-md justify-between font-mono text-xs text-ink-faint">
        <span>{days[0]!.day}</span>
        <span>today</span>
      </figcaption>
    </figure>
  );
}
