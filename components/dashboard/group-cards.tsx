import Link from "next/link";
import type { GroupSummary } from "./group-controls";

export function GroupCards({ groups }: { groups: GroupSummary[] }) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {groups.map((group) => (
        <li key={group.id}>
          <Link
            href={`/dashboard/groups/${group.id}`}
            className="flex h-full flex-col gap-2 rounded-md border border-edge bg-surface p-4 transition-colors hover:border-lime/60"
          >
            <span className="flex min-w-0 items-center gap-2 font-medium text-ink">
              <span aria-hidden="true" className="text-lime">
                ▱
              </span>
              <span className="truncate" title={group.name}>
                {group.name}
              </span>
              <span className="ml-auto text-ink-faint" aria-hidden="true">
                →
              </span>
            </span>
            {group.path.length > 1 ? (
              <p
                className="truncate font-mono text-xs text-ink-faint"
                title={group.path.map((item) => item.name).join(" / ")}
              >
                {group.path
                  .slice(0, -1)
                  .map((item) => item.name)
                  .join(" / ")}
              </p>
            ) : null}
            {group.description ? (
              <p className="line-clamp-2 break-words text-sm text-ink-muted">{group.description}</p>
            ) : null}
            <p className="mt-auto pt-1 font-mono text-xs text-ink-faint">
              {group.subtreeDraftCount} {group.subtreeDraftCount === 1 ? "file" : "files"} total ·{" "}
              {group.childGroupCount} {group.childGroupCount === 1 ? "subgroup" : "subgroups"}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}
