"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** not-found.tsx receives no props, so the return path comes from the client router. */
export function SignInToViewLink() {
  const pathname = usePathname();
  return (
    <Link
      href={`/login?next=${encodeURIComponent(pathname)}`}
      className="rounded-md bg-lime px-4 py-2 text-center font-mono text-sm font-medium text-canvas transition-colors hover:bg-lime-dim"
    >
      sign in
    </Link>
  );
}
