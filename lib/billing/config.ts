import { Polar } from "@polar-sh/sdk";
import { GiB } from "@/lib/limits/plans";

/**
 * Billing is an optional module, exactly like GitHub OAuth or Resend. Without
 * these variables the app never contacts Polar, the dashboard shows no upgrade
 * path, and plans are granted only by admins. Self-hosters therefore need no
 * payment provider at all.
 */
export type BillingConfig = {
  accessToken: string;
  webhookSecret: string;
  server: "production" | "sandbox";
  /** Explicit API origin; overrides `server`. Used for local mocks in QA. */
  serverUrl?: string;
  /** Products that grant Pro, in the order offered at checkout. */
  productIds: string[];
};

function parseProductIds(raw: string | undefined): string[] {
  return Array.from(
    new Set(
      (raw ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

export function readBillingConfig(
  env: Record<string, string | undefined> = process.env,
): BillingConfig | null {
  const accessToken = env.POLAR_ACCESS_TOKEN?.trim();
  const webhookSecret = env.POLAR_WEBHOOK_SECRET?.trim();
  const productIds = parseProductIds(env.POLAR_PRO_PRODUCT_IDS);
  if (!accessToken || !webhookSecret || productIds.length === 0) return null;
  const rawServer = env.POLAR_SERVER?.trim() ?? "";
  const serverUrl = /^https?:\/\//i.test(rawServer) ? rawServer.replace(/\/+$/, "") : undefined;
  const server = rawServer.toLowerCase() === "sandbox" ? "sandbox" : "production";
  return { accessToken, webhookSecret, server, productIds, ...(serverUrl ? { serverUrl } : {}) };
}

export function isBillingConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return readBillingConfig(env) !== null;
}

let cachedClient: { key: string; client: Polar } | undefined;

/** Lazy singleton; constructing it must not be needed at build time. */
export function getPolarClient(config: BillingConfig | null = readBillingConfig()): Polar {
  if (!config) throw new Error("Billing is not configured (POLAR_* variables are missing)");
  const key = `${config.serverUrl ?? config.server}:${config.accessToken}`;
  if (cachedClient?.key !== key) {
    cachedClient = {
      key,
      client: new Polar({
        accessToken: config.accessToken,
        ...(config.serverUrl ? { serverURL: config.serverUrl } : { server: config.server }),
      }),
    };
  }
  return cachedClient.client;
}

/**
 * A product may carry `storage_gb` in its Polar metadata so several Pro tiers
 * can coexist (e.g. Pro 10 GB, Pro 50 GB) without a deploy. Anything else falls
 * back to the configured default.
 */
export function storageBytesFromProductMetadata(
  metadata: Record<string, string | number | boolean> | null | undefined,
): number | null {
  const raw = metadata?.storage_gb ?? metadata?.storageGb;
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * GiB);
}
