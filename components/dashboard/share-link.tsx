"use client";

import { useState } from "react";
import { CopyButton } from "./copy-button";

export function ShareLink({
  currentUrl,
  versions,
}: {
  currentUrl: string;
  versions: Array<{ number: number; url: string }>;
}) {
  const [selected, setSelected] = useState("current");
  const url = versions.find((version) => String(version.number) === selected)?.url ?? currentUrl;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <select
        aria-label="Link version"
        title={selected === "current" ? "Follows future updates" : "Always opens this version"}
        value={selected}
        onChange={(event) => setSelected(event.target.value)}
        className="rounded border border-edge bg-surface px-2 py-1 text-ink-muted"
      >
        <option value="current">Latest version</option>
        {versions.map((version) => (
          <option key={version.number} value={version.number}>
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
