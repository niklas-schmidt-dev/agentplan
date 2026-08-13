import type { CSSProperties } from "react";

/** Label-over-value quota meter. Inherits font size from its container (font-mono text-xs). */
export function UsageMeter({
  label,
  used,
  limit,
  format = String,
  detail,
}: {
  label: string;
  used: number;
  limit: number | null;
  format?: (value: number) => string;
  detail?: string;
}) {
  const percentage = limit === null ? null : Math.min((used / limit) * 100, 100);
  const nearLimit = percentage !== null && percentage >= 90;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="truncate text-ink-faint">{label}</span>
      <span className="truncate tabular-nums text-ink">
        {format(used)}
        <span className={limit === null ? "text-lime" : "text-ink-faint"}>
          {" / "}
          {limit === null ? "unlimited" : format(limit)}
        </span>
      </span>
      {percentage === null ? (
        <div aria-hidden="true" className="border-t border-dashed border-lime/40" />
      ) : (
        <div
          role="progressbar"
          aria-label={`${label} quota usage`}
          aria-valuemin={0}
          aria-valuemax={limit ?? undefined}
          aria-valuenow={used}
          className="h-1 overflow-hidden rounded-full bg-edge"
        >
          <div
            className={`h-full w-(--usage) rounded-full ${nearLimit ? "bg-danger" : "bg-lime"}`}
            style={{ "--usage": `${percentage}%` } as CSSProperties}
          />
        </div>
      )}
      {detail ? <span className="truncate text-ink-faint">{detail}</span> : null}
    </div>
  );
}
