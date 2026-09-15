"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { groupRequest, type GroupSummary } from "./group-controls";

type Page = { groups: GroupSummary[]; nextCursor: string | null };
function Branch({ group, activeId }: { group: GroupSummary; activeId?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState<Page | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function load(cursor?: string) {
    setPending(true);
    setError(null);
    try {
      const query = new URLSearchParams({ parentId: group.id, limit: "30" });
      if (cursor) query.set("cursor", cursor);
      const next = await groupRequest<Page>(`/api/v1/groups?${query}`);
      setPage((previous) => ({
        groups: cursor ? [...(previous?.groups ?? []), ...next.groups] : next.groups,
        nextCursor: next.nextCursor,
      }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not load groups.");
    } finally {
      setPending(false);
    }
  }
  return (
    <li>
      <div className="flex items-center gap-1">
        {group.childGroupCount ? (
          <button
            type="button"
            className="flex size-8 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-lime/10 hover:text-lime"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${group.name}`}
            onClick={() => {
              setExpanded(!expanded);
              if (!expanded && !page) void load();
            }}
          >
            {expanded ? "−" : "+"}
          </button>
        ) : (
          <span className="w-8 shrink-0" aria-hidden="true">
            ·
          </span>
        )}
        <Link
          href={`/dashboard/groups/${group.id}`}
          aria-current={activeId === group.id ? "page" : undefined}
          title={group.path.map((item) => item.name).join(" / ")}
          className={`min-w-0 flex-1 truncate rounded py-2 hover:text-lime ${activeId === group.id ? "text-lime" : "text-ink-muted"}`}
        >
          {group.name}
        </Link>
      </div>
      {expanded ? (
        <div className="ml-2 border-l border-edge pl-1">
          {page ? (
            <ul>
              {page.groups.map((child) => (
                <Branch key={child.id} group={child} activeId={activeId} />
              ))}
            </ul>
          ) : null}
          {pending ? (
            <p role="status" className="p-2 text-ink-faint">
              Loading…
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="p-2 text-danger">
              {error}{" "}
              <button type="button" className="underline" onClick={() => void load()}>
                Retry
              </button>
            </p>
          ) : null}
          {page?.nextCursor && !pending ? (
            <button
              type="button"
              className="p-2 text-lime"
              onClick={() => void load(page.nextCursor!)}
            >
              More groups →
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function GroupNavigation({
  roots,
  activeId,
  ungrouped,
  overview,
}: {
  roots: Page;
  activeId?: string;
  ungrouped?: boolean;
  overview?: boolean;
}) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const changed = () => setRevision((value) => value + 1);
    window.addEventListener("agentplan:groups-changed", changed);
    return () => window.removeEventListener("agentplan:groups-changed", changed);
  }, []);
  return (
    <aside className="min-w-0 lg:w-48 lg:shrink-0">
      <nav
        aria-label="File library"
        className="flex flex-wrap gap-2 border-b border-edge pb-4 font-mono text-xs lg:sticky lg:top-6 lg:flex-col lg:border-b-0 lg:border-r lg:pr-4"
      >
        <Link
          href="/dashboard"
          aria-current={!activeId && !ungrouped && !overview ? "page" : undefined}
          className={`rounded px-3 py-2 hover:text-lime ${!activeId && !ungrouped && !overview ? "bg-lime/5 text-lime" : "text-ink-muted"}`}
        >
          All files
        </Link>
        <Link
          href="/dashboard?groupId=none"
          aria-current={ungrouped ? "page" : undefined}
          className={`rounded px-3 py-2 hover:text-lime ${ungrouped ? "bg-lime/5 text-lime" : "text-ink-muted"}`}
        >
          Ungrouped
        </Link>
        <Link
          href="/dashboard/groups"
          aria-current={overview ? "page" : undefined}
          className={`rounded px-3 py-2 hover:text-lime ${overview ? "bg-lime/5 text-lime" : "text-ink-muted"}`}
        >
          Groups
        </Link>
        <div className="hidden min-w-0 lg:block">
          <ul>
            {roots.groups.map((group) => (
              <Branch key={`${group.id}:${revision}`} group={group} activeId={activeId} />
            ))}
          </ul>
          {roots.nextCursor ? (
            <Link href="/dashboard/groups" className="block p-3 text-lime">
              View all groups →
            </Link>
          ) : null}
          {!roots.groups.length ? (
            <p className="px-3 py-2 leading-relaxed text-ink-faint">
              Create groups to keep related files together.
            </p>
          ) : null}
        </div>
      </nav>
    </aside>
  );
}
