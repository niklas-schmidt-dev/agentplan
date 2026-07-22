"use client";

import { useActionState, useState } from "react";
import { createTokenAction, type CreateTokenState } from "@/app/dashboard/actions";
import { CopyButton } from "./copy-button";

const inputClass =
  "rounded border border-edge bg-surface px-3 py-2 font-mono text-sm text-ink placeholder:text-ink-faint";

export function TokenCreatePanel() {
  const [state, action, pending] = useActionState<CreateTokenState, FormData>(
    createTokenAction,
    null,
  );
  const [acknowledged, setAcknowledged] = useState(false);

  if (state && "secret" in state && !acknowledged) {
    return (
      <div className="flex flex-col gap-3 rounded-md border border-lime bg-surface p-4">
        <p className="font-mono text-sm text-ink">
          Token <span className="text-lime">{state.name}</span> created. Copy it now — it will
          never be shown again.
        </p>
        <code className="break-all rounded bg-canvas px-3 py-2 font-mono text-sm text-lime">
          {state.secret}
        </code>
        <div className="flex items-center gap-3">
          <CopyButton value={state.secret} label="copy token" />
          <button
            type="button"
            onClick={() => setAcknowledged(true)}
            className="rounded-md bg-lime px-3 py-1.5 font-mono text-xs font-medium text-canvas transition-colors hover:bg-lime-dim"
          >
            I have copied the token
          </button>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 font-mono text-xs text-ink-muted">
        token name
        <input
          type="text"
          name="name"
          required
          maxLength={100}
          placeholder="e.g. ci-agent"
          className={inputClass}
          onFocus={() => setAcknowledged(false)}
        />
      </label>
      <fieldset className="flex items-center gap-4 font-mono text-xs text-ink-muted">
        <legend className="mb-1">scopes</legend>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" name="scopes" value="drafts:read" defaultChecked className="accent-lime" />
          drafts:read
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" name="scopes" value="drafts:write" defaultChecked className="accent-lime" />
          drafts:write
        </label>
      </fieldset>
      <label className="flex flex-col gap-1 font-mono text-xs text-ink-muted">
        expires in days <span className="text-ink-faint">(optional)</span>
        <input type="number" name="expiresInDays" min={1} max={365} className={inputClass} />
      </label>
      {state && "error" in state ? (
        <p role="alert" className="font-mono text-xs text-danger">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="w-fit rounded-md bg-lime px-4 py-2 font-mono text-sm font-medium text-canvas transition-colors hover:bg-lime-dim disabled:opacity-50"
      >
        {pending ? "creating…" : "create token"}
      </button>
    </form>
  );
}
