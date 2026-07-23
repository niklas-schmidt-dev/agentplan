import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { isGithubConfigured } from "@/lib/auth/auth";
import { getOptionalUser } from "@/lib/auth/session";
import { getSignupsEnabled } from "@/lib/settings/service";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  const user = await getOptionalUser();
  if (user) redirect("/dashboard");
  const signupsEnabled = await getSignupsEnabled();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-8 px-6 py-16">
      <Link href="/" className="font-mono text-sm text-ink-muted transition-colors hover:text-lime">
        <span className="text-lime">agentplan</span>.app
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Sign in</h1>
      <AuthForm githubEnabled={isGithubConfigured()} signupsEnabled={signupsEnabled} />
    </main>
  );
}
