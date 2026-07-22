export function appUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3000"
  ).replace(/\/$/, "");
}

export function draftUrl(slug: string): string {
  return `${appUrl()}/p/${slug}`;
}
