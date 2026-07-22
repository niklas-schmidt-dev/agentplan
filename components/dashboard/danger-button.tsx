"use client";

import { useState } from "react";

/** Two-step confirmation that stays keyboard-accessible (no blocking dialogs). */
export function DangerButton({
  label,
  confirmLabel,
  children,
}: {
  label: string;
  confirmLabel: string;
  children?: React.ReactNode;
}) {
  const [arming, setArming] = useState(false);

  if (!arming) {
    return (
      <button
        type="button"
        onClick={() => setArming(true)}
        className="rounded border border-edge px-2 py-1 font-mono text-xs text-danger transition-colors hover:border-danger"
      >
        {label}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="submit"
        className="rounded border border-danger bg-danger/10 px-2 py-1 font-mono text-xs text-danger transition-colors hover:bg-danger hover:text-canvas"
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        onClick={() => setArming(false)}
        className="rounded border border-edge px-2 py-1 font-mono text-xs text-ink-muted hover:text-ink"
      >
        cancel
      </button>
      {children}
    </span>
  );
}
