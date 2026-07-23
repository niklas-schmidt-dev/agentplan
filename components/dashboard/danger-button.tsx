"use client";

import { useState } from "react";

/** Two-step confirmation that stays keyboard-accessible (no blocking dialogs). */
export function DangerButton({
  label,
  confirmLabel,
  disabled = false,
  children,
}: {
  label: string;
  confirmLabel: string;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  const [arming, setArming] = useState(false);

  if (!arming) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setArming(true)}
        className="rounded border border-edge px-2 py-1 font-mono text-xs text-danger transition-colors hover:border-danger disabled:opacity-60"
      >
        {label}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="submit"
        disabled={disabled}
        className="rounded border border-danger bg-danger/10 px-2 py-1 font-mono text-xs text-danger transition-colors hover:bg-danger hover:text-canvas disabled:opacity-60"
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
