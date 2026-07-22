"use client";

import { useState } from "react";

export function CopyButton({ value, label = "copy link" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="rounded border border-edge px-2 py-1 font-mono text-xs text-ink-muted transition-colors hover:border-lime hover:text-lime"
    >
      {copied ? "copied ✓" : label}
    </button>
  );
}
