import type { UserPlan } from "@/db/schema";

/** null = no limit. All values apply to the "free" plan; "unlimited" gets null everywhere. */
export type EffectiveLimits = {
  maxDrafts: number | null;
  /** Retention, not a hard cap: uploading past it prunes the oldest versions. */
  keepVersionsPerDraft: number | null;
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

export function limitsForPlan(plan: UserPlan): EffectiveLimits {
  if (plan === "unlimited") {
    return {
      maxDrafts: null,
      keepVersionsPerDraft: null,
      maxStorageBytes: null,
      maxActiveTokens: null,
      uploadsPerTenMinutes: null,
      uploadsPerDay: null,
    };
  }
  return {
    maxDrafts: envInt("AP_MAX_DRAFTS_PER_USER", 100),
    keepVersionsPerDraft: envInt("AP_MAX_VERSIONS_PER_DRAFT", 100),
    maxStorageBytes: envInt("AP_MAX_STORAGE_BYTES_PER_USER", 250 * 1024 * 1024),
    maxActiveTokens: envInt("AP_MAX_ACTIVE_TOKENS_PER_USER", 25),
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
