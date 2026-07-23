"use client";

import { useActionState } from "react";
import {
  deleteUserAction,
  setUserRoleAction,
  type AdminActionState,
} from "@/app/dashboard/admin/actions";
import { DangerButton } from "@/components/dashboard/danger-button";
import type { UserRole } from "@/db/schema";

export function AdminUserActions({ userId, role }: { userId: string; role: UserRole }) {
  const [roleState, roleAction, rolePending] = useActionState<AdminActionState, FormData>(
    setUserRoleAction,
    null,
  );
  const [deleteState, deleteAction, deletePending] = useActionState<AdminActionState, FormData>(
    deleteUserAction,
    null,
  );
  const error = roleState?.error ?? deleteState?.error;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
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
        <form action={deleteAction}>
          <input type="hidden" name="userId" value={userId} />
          <DangerButton
            label="delete"
            confirmLabel={deletePending ? "deleting…" : "delete user + data"}
            disabled={deletePending}
          />
        </form>
      </div>
      {error ? (
        <p role="alert" className="max-w-72 text-right text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
