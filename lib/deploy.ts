export const VERCEL_DEPLOY_PRODUCTS = [
  {
    type: "integration",
    protocol: "storage",
    productSlug: "neon",
    integrationSlug: "neon",
  },
  { type: "blob" },
] as const;

export const VERCEL_REQUIRED_ENV = [
  "ADMIN_BOOTSTRAP_EMAIL",
  "BETTER_AUTH_SECRET",
  "AUTH_EMAIL_WEBHOOK_URL",
  "AUTH_EMAIL_WEBHOOK_SECRET",
  "CRON_SECRET",
] as const;

function createVercelDeployUrl(): string {
  const params = new URLSearchParams({
    "repository-url": "https://github.com/niklas-schmidt-dev/agentplan",
    "project-name": "agentplan",
    "repository-name": "agentplan",
    products: JSON.stringify(VERCEL_DEPLOY_PRODUCTS),
    envDescription:
      "AgentPlan needs an initial admin email, an auth secret, a secure email-delivery webhook, and a cron secret. Neon and Blob are provisioned during this flow.",
    envLink:
      "https://github.com/niklas-schmidt-dev/agentplan/blob/main/docs/self-hosting.md#required-values",
  });
  for (const name of VERCEL_REQUIRED_ENV) params.append("env", name);
  return `https://vercel.com/new/clone?${params.toString()}`;
}

export const VERCEL_DEPLOY_URL = createVercelDeployUrl();
