"use client";

import { useActionState, useState } from "react";
import {
  setDraftPasswordAction,
  setVisibilityAction,
  type PasswordActionState,
} from "@/app/dashboard/actions";
import type { Visibility } from "@/db/schema";

export function VisibilityControls({
  draftId,
  visibility,
  hasPassword,
}: {
  draftId: string;
  visibility: Visibility;
  hasPassword: boolean;
}) {
  const [showPasswordPanel, setShowPasswordPanel] = useState(visibility === "password");
  const [state, action, pending] = useActionState<PasswordActionState, FormData>(
    setDraftPasswordAction,
    null,
  );

  const buttonClass = (active: boolean) =>
    active
      ? "rounded bg-lime px-2 py-1 font-medium text-canvas"
      : "rounded border border-edge px-2 py-1 text-ink-muted transition-colors hover:border-lime hover:text-lime";

  return (
    <div className="ml-auto flex flex-col items-end gap-2 font-mono text-xs">
      <div className="flex items-center gap-1">
        <span className="mr-1 text-ink-faint">visibility:</span>

        <form action={setVisibilityAction}>
          <input type="hidden" name="draftId" value={draftId} />
          <button type="submit" name="visibility" value="private" className={buttonClass(visibility === "private")}>
            private
          </button>
        </form>

        <form action={setVisibilityAction}>
          <input type="hidden" name="draftId" value={draftId} />
          <button type="submit" name="visibility" value="public" className={buttonClass(visibility === "public")}>
            public
          </button>
        </form>

        <button
          type="button"
          aria-pressed={visibility === "password"}
          onClick={() => setShowPasswordPanel((open) => !open)}
          className={buttonClass(visibility === "password")}
        >
          password
        </button>
      </div>

      {visibility === "password" && !showPasswordPanel ? (
        <span className="text-ink-faint">
          protected ·{" "}
          <button
            type="button"
            onClick={() => setShowPasswordPanel(true)}
            className="underline decoration-ink-faint underline-offset-2 hover:text-lime"
          >
            change password
          </button>
        </span>
      ) : null}

      {showPasswordPanel ? (
        <form action={action} className="flex items-center gap-2">
          <input type="hidden" name="draftId" value={draftId} />
          <input
            type="password"
            name="password"
            minLength={6}
            required
            placeholder={hasPassword ? "new password" : "set a password"}
            aria-label="Draft password"
            className="rounded border border-edge bg-surface px-2 py-1 text-ink placeholder:text-ink-faint"
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded border border-lime px-2 py-1 text-lime transition-colors hover:bg-lime hover:text-canvas disabled:opacity-50"
          >
            {hasPassword ? "update" : "protect"}
          </button>
        </form>
      ) : null}

      {state && "error" in state ? (
        <p role="alert" className="text-danger">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
