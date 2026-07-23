"use client";

import { useActionState } from "react";
import {
  deleteUserAction,
  setUserPlanAction,
  setUserRoleAction,
  type AdminActionState,
} from "@/app/dashboard/admin/actions";
import { DangerButton } from "@/components/dashboard/danger-button";
import type { UserPlan, UserRole } from "@/db/schema";

export function AdminUserActions({
  userId,
  plan,
  role,
  isSelf,
}: {
  userId: string;
  plan: UserPlan;
  role: UserRole;
  isSelf: boolean;
}) {
  const [planState, planAction, planPending] = useActionState<AdminActionState, FormData>(
    setUserPlanAction,
    null,
  );
  const [roleState, roleAction, rolePending] = useActionState<AdminActionState, FormData>(
    setUserRoleAction,
    null,
  );
  const [deleteState, deleteAction, deletePending] = useActionState<AdminActionState, FormData>(
    deleteUserAction,
    null,
  );
  const error = planState?.error ?? roleState?.error ?? deleteState?.error;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <form action={planAction} className="flex items-center gap-1">
          <input type="hidden" name="userId" value={userId} />
          <label className="sr-only" htmlFor={`plan-${userId}`}>
            Account plan
          </label>
          <select
            id={`plan-${userId}`}
            name="plan"
            defaultValue={plan}
            disabled={planPending}
            className="rounded border border-edge bg-canvas px-2 py-1 text-ink-muted disabled:opacity-60"
          >
            <option value="free">free</option>
            <option value="unlimited">unlimited</option>
          </select>
          <button
            type="submit"
            disabled={planPending}
            className="rounded border border-edge px-2 py-1 text-ink-muted transition-colors hover:border-lime hover:text-lime disabled:opacity-60"
          >
            {planPending ? "saving…" : "set plan"}
          </button>
        </form>
        {!isSelf ? (
          <form action={roleAction}>
            <input type="hidden" name="userId" value={userId} />
            <input type="hidden" name="role" value={role === "admin" ? "user" : "admin"} />
            <button
              type="submit"
              disabled={rolePending}
              className="rounded border border-edge px-2 py-1 text-ink-muted transition-colors hover:border-lime hover:text-lime disabled:opacity-60"
            >
              {rolePending ? "…" : role === "admin" ? "remove admin" : "make admin"}
            </button>
          </form>
        ) : null}
        {!isSelf ? (
          <form action={deleteAction}>
            <input type="hidden" name="userId" value={userId} />
            <DangerButton
              label="delete"
              confirmLabel={deletePending ? "deleting…" : "delete user + data"}
              disabled={deletePending}
            />
          </form>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="max-w-72 text-right text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
