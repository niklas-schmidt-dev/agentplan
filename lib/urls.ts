function normalizeHttpUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

export function appUrl(): string {
  const configured =
    normalizeHttpUrl(process.env.NEXT_PUBLIC_APP_URL) ??
    normalizeHttpUrl(process.env.BETTER_AUTH_URL);
  if (configured) return configured;

  const currentDeployment = process.env.VERCEL_URL;
  const productionDeployment = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const vercelHostname =
    process.env.VERCEL_ENV === "production"
      ? (productionDeployment ?? currentDeployment)
      : (currentDeployment ?? productionDeployment);

  return vercelHostname ? `https://${vercelHostname.replace(/\/+$/, "")}` : "http://localhost:3000";
}

export function draftUrl(slug: string): string {
  return `${appUrl()}/p/${slug}`;
}
