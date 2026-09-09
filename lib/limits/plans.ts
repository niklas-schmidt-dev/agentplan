import type { DraftKind, UserPlan } from "@/db/schema";

/** null = no limit. */
export type EffectiveLimits = {
  maxDrafts: number | null;
  /** Hard cap: existing versions stay available when uploads reach the limit. */
  keepVersionsByKind: Record<DraftKind, number | null>;
  maxStorageBytes: number | null;
  maxActiveTokens: number | null;
  uploadsPerTenMinutes: number | null;
  uploadsPerDay: number | null;
};

/** Env overrides let tests and ops tune limits without a deploy. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export const GiB = 1024 ** 3;

/**
 * Storage included with Pro when neither the billing product nor an admin says
 * otherwise. Pro is deliberately storage-bound: drafts, versions, and tokens are
 * unlimited, so this single number is what the subscription actually sells.
 */
export function defaultProStorageBytes(): number {
  return envInt("AP_PRO_STORAGE_BYTES", 10 * GiB);
}

/**
 * Plan tiers:
 * - free: every cap applies.
 * - pro: only storage (and generous upload rate limits) apply. `storageBytes`
 *   comes from the billing subscription; admins granting Pro manually get the
 *   default.
 * - unlimited: operator/admin plan; bypasses everything, never sold.
 */
export function limitsForPlan(plan: UserPlan, storageBytes?: number | null): EffectiveLimits {
  if (plan === "unlimited") {
    return {
      maxDrafts: null,
      keepVersionsByKind: { html: null, image: null, video: null },
      maxStorageBytes: null,
      maxActiveTokens: null,
      uploadsPerTenMinutes: null,
      uploadsPerDay: null,
    };
  }
  if (plan === "pro") {
    return {
      maxDrafts: null,
      keepVersionsByKind: { html: null, image: null, video: null },
      maxStorageBytes: storageBytes ?? defaultProStorageBytes(),
      maxActiveTokens: null,
      uploadsPerTenMinutes: envInt("AP_PRO_UPLOADS_PER_10MIN", 120),
      uploadsPerDay: envInt("AP_PRO_UPLOADS_PER_DAY", 2_000),
    };
  }
  return {
    maxDrafts: envInt("AP_MAX_DRAFTS_PER_USER", 50),
    keepVersionsByKind: {
      html: envInt("AP_MAX_VERSIONS_PER_DRAFT", 100),
      image: envInt("AP_MAX_IMAGE_VERSIONS_PER_DRAFT", 20),
      video: envInt("AP_MAX_VIDEO_VERSIONS_PER_DRAFT", 2),
    },
    maxStorageBytes: envInt("AP_MAX_STORAGE_BYTES_PER_USER", 50 * 1024 * 1024),
    maxActiveTokens: envInt("AP_MAX_ACTIVE_TOKENS_PER_USER", 5),
    uploadsPerTenMinutes: envInt("AP_UPLOADS_PER_10MIN", 30),
    uploadsPerDay: envInt("AP_UPLOADS_PER_DAY", 300),
  };
}

/** Attempts per draft+IP per 15 minutes; guards viewers, so it is plan-independent. */
export function passwordAttemptsPerWindow(): number {
  return envInt("AP_PASSWORD_ATTEMPTS_PER_15MIN", 10);
}

export function deletedDraftRetentionDays(): number {
  return envInt("AP_DELETED_RETENTION_DAYS", 7);
}

export function tokenMutationsPerHour(): number {
  return envInt("AP_TOKEN_MUTATIONS_PER_HOUR", 60);
}

export function tokenMutationsPerDay(): number {
  return envInt("AP_TOKEN_MUTATIONS_PER_DAY", 200);
}

export function retiredTokenRetentionDays(): number {
  return envInt("AP_RETIRED_TOKEN_RETENTION_DAYS", 30);
}

export function auditRetentionDays(): number {
  return envInt("AP_AUDIT_RETENTION_DAYS", 180);
}

export function viewRetentionDays(): number {
  return envInt("AP_VIEW_RETENTION_DAYS", 365);
}
