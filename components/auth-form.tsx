"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SignInButton } from "@/components/auth-buttons";
import { authClient } from "@/lib/auth/client";

const inputClass =
  "w-full rounded border border-edge bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-lime focus:outline-none";

export function AuthForm({
  githubEnabled,
  signupsEnabled,
}: {
  githubEnabled: boolean;
  signupsEnabled: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const name = String(form.get("name") ?? "").trim();

    setPending(true);
    setError(null);
    setNotice(null);
    const { error: authError } =
      mode === "signup"
        ? await authClient.signUp.email({
            email,
            password,
            name: name || email.split("@")[0] || email,
            callbackURL: "/dashboard",
          })
        : await authClient.signIn.email({ email, password });
    setPending(false);

    if (authError) {
      setError(authError.message ?? "Something went wrong. Please try again.");
      return;
    }
    if (mode === "signup") {
      // Better Auth intentionally returns the same successful shape for a new
      // address and an existing address. Keep the UI equally non-enumerating.
      setNotice("If this address can be registered, a verification link has been sent.");
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-5">
      {githubEnabled ? (
        <>
          <SignInButton label="continue with github" />
          <div className="flex items-center gap-3 font-mono text-xs text-ink-faint">
            <span className="h-px flex-1 bg-edge" />
            or with email
            <span className="h-px flex-1 bg-edge" />
          </div>
        </>
      ) : null}

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        {mode === "signup" ? (
          <>
            <label className="sr-only" htmlFor="auth-name">
              name
            </label>
            <input
              id="auth-name"
              type="text"
              name="name"
              placeholder="name (optional)"
              autoComplete="name"
              className={inputClass}
            />
          </>
        ) : null}
        <label className="sr-only" htmlFor="auth-email">
          email
        </label>
        <input
          id="auth-email"
          type="email"
          name="email"
          required
          placeholder="email"
          autoComplete="email"
          className={inputClass}
        />
        <label className="sr-only" htmlFor="auth-password">
          password
        </label>
        <input
          id="auth-password"
          type="password"
          name="password"
          required
          minLength={8}
          placeholder="password"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          className={inputClass}
        />
        {error ? <p className="font-mono text-xs text-danger">{error}</p> : null}
        {notice ? (
          <p role="status" className="font-mono text-xs text-lime">
            {notice}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-lime bg-lime px-4 py-2 font-mono text-sm font-medium text-canvas transition-colors hover:bg-lime-dim disabled:opacity-60"
        >
          {pending ? "…" : mode === "signup" ? "create account" : "sign in"}
        </button>
      </form>

      {signupsEnabled ? (
        <div className="flex flex-wrap gap-4">
          <button
            type="button"
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError(null);
              setNotice(null);
            }}
            className="w-fit font-mono text-xs text-ink-muted transition-colors hover:text-lime"
          >
            {mode === "signin" ? "no account? sign up →" : "have an account? sign in →"}
          </button>
          {mode === "signin" ? (
            <a
              href="/forgot-password"
              className="font-mono text-xs text-ink-muted transition-colors hover:text-lime"
            >
              forgot password?
            </a>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="font-mono text-xs text-ink-faint">
            sign-ups are currently disabled.
          </p>
          <a
            href="/forgot-password"
            className="font-mono text-xs text-ink-muted transition-colors hover:text-lime"
          >
            forgot password?
          </a>
        </div>
      )}
    </div>
  );
}
