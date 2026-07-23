import Link from "next/link";
import { ResetPasswordForm } from "@/components/password-recovery-form";

export const metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-8 px-6 py-16">
      <Link href="/" className="font-mono text-sm text-ink-muted transition-colors hover:text-lime">
        <span className="text-lime">agentplan</span>.app
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Choose a new password</h1>
      <ResetPasswordForm token={token ?? null} invalid={Boolean(error)} />
    </main>
  );
}
