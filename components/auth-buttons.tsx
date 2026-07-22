"use client";

import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";

export function SignInButton({ label = "sign in with github" }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => authClient.signIn.social({ provider: "github", callbackURL: "/dashboard" })}
      className="w-fit rounded-md border border-lime bg-lime px-4 py-2 font-mono text-sm font-medium text-canvas transition-colors hover:bg-lime-dim"
    >
      {label}
    </button>
  );
}

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        await authClient.signOut();
        router.push("/");
        router.refresh();
      }}
      className="w-fit rounded-md border border-edge px-3 py-1.5 font-mono text-xs text-ink-muted transition-colors hover:border-lime hover:text-lime"
    >
      sign out
    </button>
  );
}
