"use client";

import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CopyButton } from "./copy-button";

export function ShareLink({
  currentUrl,
  selected,
  versions,
}: {
  currentUrl: string;
  selected: string;
  versions: Array<{ id: string; number: number; url: string }>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const url = versions.find((version) => version.id === selected)?.url ?? currentUrl;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <select
        aria-label="Draft version"
        title={selected === "current" ? "Follows future updates" : "Always opens this version"}
        value={selected}
        disabled={pending}
        aria-busy={pending}
        onChange={(event) => {
          const params = new URLSearchParams(searchParams);
          if (event.target.value === "current") params.delete("version");
          else params.set("version", event.target.value);
          const query = params.toString();
          startTransition(() => {
            router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
          });
        }}
        className="rounded border border-edge bg-surface px-2 py-1 text-ink-muted disabled:opacity-50"
      >
        <option value="current">Latest version</option>
        {versions.map((version) => (
          <option key={version.id} value={version.id}>
            Version {version.number} · fixed
          </option>
        ))}
      </select>
      <CopyButton key={url} value={url} />
      <a
        href={url}
        title={url}
        target="_blank"
        rel="noreferrer"
        className="rounded border border-edge px-2 py-1 text-ink-muted hover:text-lime"
      >
        open ↗
      </a>
    </div>
  );
}
