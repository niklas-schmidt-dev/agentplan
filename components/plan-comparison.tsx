import type { ReactNode } from "react";
import type { ProPlanOffer } from "@/lib/billing/service";
import { formatBytes, formatPrice } from "@/lib/format";
import type { EffectiveLimits } from "@/lib/limits/plans";

export type PlanColumn = {
  key: string;
  name: string;
  price: ReactNode;
  limits: EffectiveLimits;
  highlighted: boolean;
  /** Rendered under the column; the checkout button or a status line. */
  action?: ReactNode;
};

function intervalLabel(interval: string | null): string {
  switch (interval) {
    case "month":
      return "month";
    case "year":
      return "year";
    case "week":
      return "week";
    case "day":
      return "day";
    default:
      return "";
  }
}

export function offerPrice(offer: ProPlanOffer): ReactNode {
  if (offer.amount === null || !offer.currency) return "—";
  const interval = intervalLabel(offer.recurringInterval);
  return (
    <>
      {formatPrice(offer.amount, offer.currency)}
      {interval ? <span className="text-base text-ink-faint"> / {interval}</span> : null}
    </>
  );
}

/** Values that read as "the good one" are emphasised in the paid column. */
const EMPHASISED = new Set(["unlimited", "included"]);

function limitCell(value: number | null, format: (value: number) => string = String): string {
  return value === null ? "unlimited" : format(value);
}

function versionsCell(limits: EffectiveLimits): string {
  const { html, image, video } = limits.keepVersionsByKind;
  if (html === null && image === null && video === null) return "unlimited";
  if (html === image && image === video) return String(html);
  return `${html ?? "∞"} html · ${image ?? "∞"} image · ${video ?? "∞"} video`;
}

/** Restore copies an old version forward, so it needs room for more than one. */
function restoreCell(limits: EffectiveLimits): string {
  const { html, image, video } = limits.keepVersionsByKind;
  return [html, image, video].every((cap) => cap === null || cap > 1) ? "included" : "—";
}

// Upload rate windows are abuse throttles shared by every plan and are
// deliberately not listed here.
const rows: Array<{ label: string; cell: (limits: EffectiveLimits) => string }> = [
  { label: "storage", cell: (limits) => limitCell(limits.maxStorageBytes, formatBytes) },
  { label: "drafts", cell: (limits) => limitCell(limits.maxDrafts) },
  { label: "versions per draft", cell: versionsCell },
  { label: "restore any version", cell: restoreCell },
  { label: "api tokens", cell: (limits) => limitCell(limits.maxActiveTokens) },
];

/**
 * A spec sheet, not a pricing grid: one hairline table, big numerals, the
 * paid column marked in lime. Server-renderable so it works on the public
 * pricing page and inside the signed-in plan page alike.
 */
export function PlanComparison({ columns }: { columns: PlanColumn[] }) {
  const template = `minmax(8rem, 11rem) repeat(${columns.length}, minmax(0, 1fr))`;
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[36rem]" role="table" aria-label="Plan comparison">
        <div
          role="row"
          className="grid items-end gap-x-6"
          style={{ gridTemplateColumns: template }}
        >
          <span role="columnheader" className="border-t-2 border-transparent pt-4 pb-5">
            <span className="sr-only">feature</span>
          </span>
          {columns.map((column) => (
            <div
              key={column.key}
              role="columnheader"
              className={`flex flex-col gap-2 border-t-2 pt-4 pb-5 ${
                column.highlighted ? "border-lime" : "border-edge"
              }`}
            >
              <span
                className={`font-mono text-xs uppercase tracking-[0.2em] ${
                  column.highlighted ? "text-lime" : "text-ink-faint"
                }`}
              >
                {column.name}
              </span>
              <span className="font-mono text-3xl font-medium tabular-nums tracking-tight text-ink sm:text-4xl">
                {column.price}
              </span>
            </div>
          ))}
        </div>
        {rows.map((row) => (
          <div
            key={row.label}
            role="row"
            className="grid items-baseline gap-x-6 border-t border-edge py-3.5"
            style={{ gridTemplateColumns: template }}
          >
            <span role="rowheader" className="font-mono text-xs text-ink-faint">
              {row.label}
            </span>
            {columns.map((column) => {
              const value = row.cell(column.limits);
              return (
                <span
                  key={column.key}
                  role="cell"
                  className={`font-mono text-sm tabular-nums ${
                    EMPHASISED.has(value) && column.highlighted
                      ? "text-lime"
                      : column.highlighted
                        ? "text-ink"
                        : value === "—"
                          ? "text-ink-faint"
                          : "text-ink-muted"
                  }`}
                >
                  {value}
                </span>
              );
            })}
          </div>
        ))}
        {columns.some((column) => column.action) ? (
          <div
            role="row"
            className="grid items-start gap-x-6 border-t border-edge pt-5"
            style={{ gridTemplateColumns: template }}
          >
            <span role="rowheader">
              <span className="sr-only">action</span>
            </span>
            {columns.map((column) => (
              <div key={column.key} role="cell" className="min-w-0">
                {column.action}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
