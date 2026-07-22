"use client";

import { useActionState } from "react";
import { uploadDraftAction, uploadVersionAction, type UploadState } from "@/app/dashboard/actions";

const inputClass =
  "rounded border border-edge bg-surface px-3 py-2 font-mono text-sm text-ink placeholder:text-ink-faint";

export function NewDraftForm() {
  const [state, action, pending] = useActionState<UploadState, FormData>(uploadDraftAction, null);

  return (
    <form action={action} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 font-mono text-xs text-ink-muted">
        html file
        <input type="file" name="file" accept=".html,.htm,text/html" required className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 font-mono text-xs text-ink-muted">
        title <span className="text-ink-faint">(optional, defaults to filename)</span>
        <input type="text" name="title" maxLength={200} className={inputClass} />
      </label>
      <fieldset className="flex items-center gap-4 font-mono text-xs text-ink-muted">
        <legend className="sr-only">Visibility</legend>
        <label className="flex items-center gap-1.5">
          <input type="radio" name="visibility" value="private" defaultChecked className="accent-lime" />
          private
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" name="visibility" value="public" className="accent-lime" />
          public
        </label>
      </fieldset>
      {state?.error ? (
        <p role="alert" className="font-mono text-xs text-danger">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="w-fit rounded-md bg-lime px-4 py-2 font-mono text-sm font-medium text-canvas transition-colors hover:bg-lime-dim disabled:opacity-50"
      >
        {pending ? "uploading…" : "upload"}
      </button>
    </form>
  );
}

export function NewVersionForm({ draftId }: { draftId: string }) {
  const [state, action, pending] = useActionState<UploadState, FormData>(uploadVersionAction, null);

  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="draftId" value={draftId} />
      <label className="flex flex-col gap-1 font-mono text-xs text-ink-muted">
        upload new version
        <input type="file" name="file" accept=".html,.htm,text/html" required className={inputClass} />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-lime px-3 py-2 font-mono text-xs text-lime transition-colors hover:bg-lime hover:text-canvas disabled:opacity-50"
      >
        {pending ? "uploading…" : "upload version"}
      </button>
      {state?.error ? (
        <p role="alert" className="w-full font-mono text-xs text-danger">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
