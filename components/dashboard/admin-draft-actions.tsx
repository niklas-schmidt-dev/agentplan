"use client";

import { useActionState } from "react";
import { removeDraftAction, type AdminActionState } from "@/app/dashboard/admin/actions";
import { DangerButton } from "@/components/dashboard/danger-button";

export function AdminDraftActions({ draftId }: { draftId: string }) {
  const [state, action, pending] = useActionState<AdminActionState, FormData>(
    removeDraftAction,
    null,
  );

  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="draftId" value={draftId} />
      <DangerButton
        label="remove"
        confirmLabel={pending ? "removing…" : "remove content"}
        disabled={pending}
      />
      {state?.error ? (
        <p role="alert" className="max-w-72 text-right font-mono text-xs text-danger">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
