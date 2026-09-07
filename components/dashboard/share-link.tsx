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
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <label className="flex flex-wrap items-center gap-2 text-ink-muted">
        Share
        <select
          aria-label="Link version"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          className="rounded border border-edge bg-surface px-2 py-1"
        >
          <option value="current">Latest version</option>
          {versions.map((version) => (
            <option key={version.number} value={version.number}>
              Fixed version {version.number}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 break-all rounded bg-surface px-2 py-1 text-ink-muted">{url}</code>
        <CopyButton key={url} value={url} />
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="rounded border border-edge px-2 py-1 text-ink-muted hover:text-lime"
        >
          open ↗
        </a>
      </div>
      <p className="text-ink-faint">
        {selected === "current"
          ? "This link follows future updates."
          : "This link always opens the selected version."}{" "}
        Copying a link keeps the audience unchanged.
      </p>
    </div>
  );
}
