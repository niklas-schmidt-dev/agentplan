"use client";

import { useActionState, useState } from "react";
import {
  setDraftPasswordAction,
  setVisibilityAction,
  type PasswordActionState,
} from "@/app/dashboard/actions";
import type { Visibility } from "@/db/schema";

type VisibilityControlsProps = {
  draftId: string;
  visibility: Visibility;
  hasPassword: boolean;
};

export function VisibilityControls(props: VisibilityControlsProps) {
  // A server-action visibility change remounts the stateful controls so an
  // open password form cannot survive after switching to public/private.
  return <VisibilityControlsState key={props.visibility} {...props} />;
}

function VisibilityControlsState({ draftId, visibility, hasPassword }: VisibilityControlsProps) {
  const [showPasswordPanel, setShowPasswordPanel] = useState(false);
  const [state, action, pending] = useActionState<PasswordActionState, FormData>(
    setDraftPasswordAction,
    null,
  );

  const buttonClass = (active: boolean) =>
    active
      ? "rounded bg-lime px-2 py-1 font-medium text-canvas"
      : "rounded border border-edge px-2 py-1 text-ink-muted transition-colors hover:border-lime hover:text-lime";

  return (
    <details
      className="group relative ml-auto font-mono text-xs"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }
      }}
    >
      <summary
        aria-label="Access settings"
        className="flex cursor-pointer list-none items-center gap-2 rounded border border-edge px-2 py-1 text-ink-muted hover:border-lime hover:text-lime [&::-webkit-details-marker]:hidden"
      >
        <span
          className={`size-1.5 rounded-full ${visibility === "public" ? "bg-lime" : "bg-ink-faint"}`}
          aria-hidden="true"
        />
        {visibility}
        <span aria-hidden="true" className="text-ink-faint group-open:rotate-180">
          ⌄
        </span>
      </summary>
      <div className="absolute right-0 top-full z-20 mt-2 flex w-72 max-w-[calc(100vw-3rem)] flex-col gap-3 rounded-md border border-edge bg-surface p-4 shadow-xl">
        <p className="text-ink-muted" role="status">
          {visibility === "private"
            ? "Only you"
            : visibility === "public"
              ? "Anyone with the link"
              : "Link + password"}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          <span className="sr-only">Change access</span>

          <form action={setVisibilityAction}>
            <input type="hidden" name="draftId" value={draftId} />
            <button
              type="submit"
              name="visibility"
              value="private"
              aria-pressed={visibility === "private"}
              className={buttonClass(visibility === "private")}
            >
              private
            </button>
          </form>

          <form action={setVisibilityAction}>
            <input type="hidden" name="draftId" value={draftId} />
            <button
              type="submit"
              name="visibility"
              value="public"
              aria-pressed={visibility === "public"}
              className={buttonClass(visibility === "public")}
            >
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
          <form action={action} className="flex w-full flex-wrap items-center gap-2">
            <input type="hidden" name="draftId" value={draftId} />
            <input
              type="password"
              name="password"
              minLength={6}
              required
              placeholder={hasPassword ? "new password" : "set a password"}
              aria-label="Draft password"
              className="min-w-0 flex-1 rounded border border-edge bg-surface px-2 py-1 text-ink placeholder:text-ink-faint"
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

        {visibility === "public" ? (
          <p className="text-ink-faint">Private or password access replaces this URL.</p>
        ) : null}

        {state && "error" in state ? (
          <p role="alert" className="text-danger">
            {state.error}
          </p>
        ) : null}
      </div>
    </details>
  );
}
