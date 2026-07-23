import Link from "next/link";
import { ForgotPasswordForm } from "@/components/password-recovery-form";

export const metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-8 px-6 py-16">
      <Link href="/" className="font-mono text-sm text-ink-muted transition-colors hover:text-lime">
        <span className="text-lime">agentplan</span>.app
      </Link>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Reset password</h1>
        <p className="text-sm text-ink-muted">
          Enter your email address. The response is identical whether or not an account exists.
        </p>
      </div>
      <ForgotPasswordForm />
      <Link href="/login" className="font-mono text-xs text-ink-muted hover:text-lime">
        ← back to sign in
      </Link>
    </main>
  );
}
