"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function FileFilters({
  search,
  visibility,
  recent,
  groupId,
  includeDescendants,
}: {
  search?: string;
  visibility?: string;
  recent?: boolean;
  groupId?: string | null;
  includeDescendants?: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState(search ?? "");
  const [recursive, setRecursive] = useState(includeDescendants ?? false);
  const group = typeof groupId === "string";
  return (
    <form
      method="GET"
      className="flex flex-wrap items-center gap-3 font-mono text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        const params = new URLSearchParams();
        for (const [name, value] of new FormData(event.currentTarget)) {
          if (typeof value === "string" && value) params.set(name, value);
        }
        // Reset the outgoing form to its URL state before Next preserves it for Back.
        event.currentTarget.reset();
        setQuery(search ?? "");
        setRecursive(includeDescendants ?? false);
        router.push(`${group ? `/dashboard/groups/${groupId}` : "/dashboard"}?${params}`);
      }}
    >
      {groupId === null ? <input type="hidden" name="groupId" value="none" /> : null}
      <label className="flex min-w-40 flex-1 items-center gap-2 text-ink-muted">
        <span className="sr-only">Search by title</span>
        <input
          type="search"
          name="q"
          value={query}
          onChange={(event) => {
            const next = event.target.value;
            if (group && next.trim() && next.trim() !== (search ?? "")) setRecursive(true);
            setQuery(next);
          }}
          placeholder="search titles…"
          className="w-full min-w-40 rounded border border-edge bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint"
        />
      </label>
      <select
        name="visibility"
        defaultValue={visibility ?? ""}
        className="rounded border border-edge bg-surface px-2 py-2 text-ink-muted"
        aria-label="Filter by visibility"
      >
        <option value="">all visibilities</option>
        <option value="public">public</option>
        <option value="private">private</option>
        <option value="password">password</option>
      </select>
      <label className="flex items-center gap-1.5 text-ink-muted">
        <input
          type="checkbox"
          name="recent"
          value="1"
          defaultChecked={recent}
          className="accent-lime"
        />
        updated this week
      </label>
      {group ? (
        <>
          <input type="hidden" name="includeDescendants" value={recursive ? "1" : "0"} />
          <label className="flex items-center gap-1.5 text-ink-muted">
            <input
              type="checkbox"
              checked={recursive}
              onChange={(event) => setRecursive(event.target.checked)}
              className="accent-lime"
            />
            Include subgroups
          </label>
        </>
      ) : null}
      <button
        type="submit"
        className="rounded border border-edge px-3 py-2 text-ink-muted transition-colors hover:border-lime hover:text-lime"
      >
        filter
      </button>
      {group && query.trim() ? (
        <Link href={`/dashboard?q=${encodeURIComponent(query.trim())}`} className="text-lime">
          Search everywhere →
        </Link>
      ) : null}
    </form>
  );
}
