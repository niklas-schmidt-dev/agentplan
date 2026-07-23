"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";

const inputClass =
  "w-full rounded border border-edge bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-lime focus:outline-none";

export function ForgotPasswordForm() {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    await authClient.requestPasswordReset({
      email,
      redirectTo: "/reset-password",
    });
    setPending(false);
    setNotice("If the address exists, a password-reset link has been sent.");
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="sr-only" htmlFor="recovery-email">
        email
      </label>
      <input
        id="recovery-email"
        type="email"
        name="email"
        required
        autoComplete="email"
        placeholder="email"
        className={inputClass}
      />
      {notice ? (
        <p role="status" className="font-mono text-xs text-lime">
          {notice}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-lime bg-lime px-4 py-2 font-mono text-sm font-medium text-canvas disabled:opacity-60"
      >
        {pending ? "…" : "send reset link"}
      </button>
    </form>
  );
}

export function ResetPasswordForm({
  token,
  invalid,
}: {
  token: string | null;
  invalid: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(
    invalid || !token ? "This reset link is invalid or has expired." : null,
  );

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("password") ?? "");
    setPending(true);
    setError(null);
    const result = await authClient.resetPassword({ newPassword, token });
    setPending(false);
    if (result.error) {
      setError("This reset link is invalid or has expired.");
      return;
    }
    router.push("/login");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="sr-only" htmlFor="recovery-password">
        new password
      </label>
      <input
        id="recovery-password"
        type="password"
        name="password"
        required
        minLength={8}
        maxLength={128}
        autoComplete="new-password"
        placeholder="new password"
        disabled={!token}
        className={inputClass}
      />
      {error ? (
        <p role="alert" className="font-mono text-xs text-danger">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending || !token}
        className="rounded-md border border-lime bg-lime px-4 py-2 font-mono text-sm font-medium text-canvas disabled:opacity-60"
      >
        {pending ? "…" : "set new password"}
      </button>
    </form>
  );
}
