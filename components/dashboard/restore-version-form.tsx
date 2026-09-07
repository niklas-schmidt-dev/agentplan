"use client";

import { useActionState } from "react";
import { restoreVersionAction } from "@/app/dashboard/actions";

export function RestoreVersionForm({ draftId, versionId }: { draftId: string; versionId: string }) {
  const [state, action, pending] = useActionState(restoreVersionAction, null);
  return (
    <form action={action} className="flex flex-col items-start gap-2">
      <input type="hidden" name="draftId" value={draftId} />
      <input type="hidden" name="versionId" value={versionId} />
      <button
        type="submit"
        disabled={pending}
        title="Copy this version into a new current version"
        className="rounded border border-edge px-2 py-1 text-ink-muted transition-colors hover:border-lime hover:text-lime disabled:opacity-50"
      >
        {pending ? "restoring…" : "restore as current"}
      </button>
      {state?.error ? (
        <p role="alert" className="max-w-sm text-danger">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
