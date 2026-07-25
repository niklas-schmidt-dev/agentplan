"use client";

import { useActionState } from "react";
import {
  blockUserAction,
  deleteAndBlockUserAction,
  deleteUserAction,
  setUserPlanAction,
  setUserRoleAction,
  unblockUserAction,
  type AdminActionState,
} from "@/app/dashboard/admin/actions";
import { DangerButton } from "@/components/dashboard/danger-button";
import type { UserPlan, UserRole } from "@/db/schema";

export function AdminUserActions({
  userId,
  plan,
  role,
  isSelf,
  blockedAt,
  blockId,
  blockReason,
}: {
  userId: string;
  plan: UserPlan;
  role: UserRole;
  isSelf: boolean;
  blockedAt: Date | null;
  blockId: string | null;
  blockReason: string | null;
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
  const [blockState, blockAction, blockPending] = useActionState<AdminActionState, FormData>(
    blockUserAction,
    null,
  );
  const [unblockState, unblockAction, unblockPending] = useActionState<AdminActionState, FormData>(
    unblockUserAction,
    null,
  );
  const [deleteBlockState, deleteBlockAction, deleteBlockPending] = useActionState<
    AdminActionState,
    FormData
  >(deleteAndBlockUserAction, null);
  const error =
    planState?.error ??
    roleState?.error ??
    deleteState?.error ??
    blockState?.error ??
    unblockState?.error ??
    deleteBlockState?.error;
  const isBlocked = blockedAt !== null;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {!isBlocked ? (
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
        ) : null}
        {!isSelf && !isBlocked ? (
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
        {!isSelf && !isBlocked ? (
          <form action={blockAction}>
            <input type="hidden" name="userId" value={userId} />
            <DangerButton
              label="block"
              confirmLabel={blockPending ? "blocking…" : "confirm block"}
              disabled={blockPending}
            >
              <label className="sr-only" htmlFor={`block-reason-${userId}`}>
                Internal block reason
              </label>
              <input
                id={`block-reason-${userId}`}
                name="reason"
                required
                minLength={1}
                maxLength={500}
                placeholder="internal reason"
                className="w-48 rounded border border-edge bg-canvas px-2 py-1 text-ink placeholder:text-ink-faint"
              />
            </DangerButton>
          </form>
        ) : null}
        {!isSelf && !isBlocked ? (
          <form action={deleteAction}>
            <input type="hidden" name="userId" value={userId} />
            <DangerButton
              label="delete"
              confirmLabel={deletePending ? "deleting…" : "delete; allow rejoin"}
              disabled={deletePending}
            />
          </form>
        ) : null}
        {!isSelf && !isBlocked ? (
          <form action={deleteBlockAction}>
            <input type="hidden" name="userId" value={userId} />
            <DangerButton
              label="delete + block"
              confirmLabel={deleteBlockPending ? "deleting…" : "delete + retain identities"}
              disabled={deleteBlockPending}
            >
              <label className="sr-only" htmlFor={`delete-block-reason-${userId}`}>
                Internal delete and block reason
              </label>
              <input
                id={`delete-block-reason-${userId}`}
                name="reason"
                required
                minLength={1}
                maxLength={500}
                placeholder="internal reason"
                className="w-48 rounded border border-edge bg-canvas px-2 py-1 text-ink placeholder:text-ink-faint"
              />
            </DangerButton>
          </form>
        ) : null}
        {!isSelf && isBlocked && blockId ? (
          <form action={unblockAction}>
            <input type="hidden" name="blockId" value={blockId} />
            <button
              type="submit"
              disabled={unblockPending}
              className="rounded border border-edge px-2 py-1 text-ink-muted transition-colors hover:border-lime hover:text-lime disabled:opacity-60"
            >
              {unblockPending ? "unblocking…" : "unblock"}
            </button>
          </form>
        ) : null}
        {!isSelf && isBlocked ? (
          <form action={deleteBlockAction}>
            <input type="hidden" name="userId" value={userId} />
            <input type="hidden" name="reason" value={blockReason ?? "Existing identity block"} />
            <DangerButton
              label="delete data, keep blocked"
              confirmLabel={deleteBlockPending ? "deleting…" : "delete retained account"}
              disabled={deleteBlockPending}
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
