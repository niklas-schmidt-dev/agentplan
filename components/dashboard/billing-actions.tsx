"use client";

import { useActionState } from "react";
import {
  openPortalAction,
  refreshSubscriptionAction,
  startCheckoutAction,
  type BillingActionState,
} from "@/app/dashboard/billing/actions";

const primaryClass =
  "rounded-md border border-lime bg-lime px-4 py-2 font-mono text-sm font-medium text-canvas transition-colors hover:bg-lime-dim disabled:opacity-60";
const secondaryClass =
  "rounded border border-edge px-3 py-1.5 font-mono text-xs text-ink-muted transition-colors hover:border-lime hover:text-lime disabled:opacity-60";

export function CheckoutButton({ productId, label }: { productId: string; label: string }) {
  const [state, action, pending] = useActionState<BillingActionState, FormData>(
    startCheckoutAction,
    null,
  );
  return (
    <form action={action} className="flex flex-col items-start gap-1">
      <input type="hidden" name="productId" value={productId} />
      <button type="submit" disabled={pending} className={primaryClass}>
        {pending ? "opening checkout…" : label}
      </button>
      {state?.error ? (
        <p role="alert" className="font-mono text-xs text-danger">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function PortalButton() {
  const [state, action, pending] = useActionState<BillingActionState, FormData>(
    openPortalAction,
    null,
  );
  return (
    <form action={action} className="flex flex-col items-start gap-1">
      <button type="submit" disabled={pending} className={secondaryClass}>
        {pending ? "opening…" : "manage subscription ↗"}
      </button>
      {state?.error ? (
        <p role="alert" className="font-mono text-xs text-danger">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function RefreshSubscriptionButton() {
  const [state, action, pending] = useActionState<BillingActionState, FormData>(
    refreshSubscriptionAction,
    null,
  );
  return (
    <form action={action} className="flex flex-col items-start gap-1">
      <button type="submit" disabled={pending} className={secondaryClass}>
        {pending ? "refreshing…" : "refresh status"}
      </button>
      {state?.error ? (
        <p role="alert" className="font-mono text-xs text-danger">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
