"use client";

import { useActionState } from "react";
import { unblockUserAction, type AdminActionState } from "@/app/dashboard/admin/actions";
import { DangerButton } from "@/components/dashboard/danger-button";

export function AdminUnblockButton({ blockId }: { blockId: string }) {
  const [state, action, pending] = useActionState<AdminActionState, FormData>(
    unblockUserAction,
    null,
  );

  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="blockId" value={blockId} />
      <DangerButton
        label="unblock"
        confirmLabel={pending ? "unblocking…" : "allow identity again"}
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
