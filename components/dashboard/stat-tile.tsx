export function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-edge bg-surface p-4">
      <span className="truncate font-mono text-xs text-ink-muted">{label}</span>
      <span className="text-2xl font-semibold tabular-nums text-ink">{value}</span>
      {detail ? <span className="truncate font-mono text-xs text-ink-faint">{detail}</span> : null}
    </div>
  );
}
