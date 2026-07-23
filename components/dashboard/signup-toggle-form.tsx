"use client";

import { useActionState } from "react";
import { setSignupsEnabledAction, type AdminActionState } from "@/app/dashboard/admin/actions";

export function SignupToggleForm({ enabled }: { enabled: boolean }) {
  const [state, action, pending] = useActionState<AdminActionState, FormData>(
    setSignupsEnabledAction,
    null,
  );

  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-edge px-3 py-1.5 font-mono text-xs text-ink-muted transition-colors hover:border-lime hover:text-lime disabled:opacity-60"
      >
        {pending ? "…" : enabled ? "disable sign-ups" : "enable sign-ups"}
      </button>
      {state?.error ? (
        <p role="alert" className="max-w-72 text-right font-mono text-xs text-danger">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
