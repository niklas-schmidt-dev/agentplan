import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const userPlan = pgEnum("user_plan", ["free", "unlimited"]);
export const userRole = pgEnum("user_role", ["user", "admin"]);

// --- Better Auth tables (shape must match better-auth's generated schema) ---

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    // App-managed, invisible to Better Auth. "unlimited" bypasses quotas and
    // upload rate limits; set via scripts/set-user-plan.ts.
    plan: userPlan("plan").notNull().default("free"),
    // Assigned by the signup hook in lib/auth/auth.ts: the very first user
    // becomes "admin"; admins manage users and settings under /dashboard/admin.
    role: userRole("role").notNull().default("user"),
    // Denormalized from user_blocks by database triggers. This is the hot-path
    // access flag; user_blocks remains the durable moderation record.
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("users_role_blocked_at_idx").on(table.role, table.blockedAt)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("accounts_user_id_idx").on(table.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)],
);

// --- Application tables ---

export const userBlocks = pgTable(
  "user_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Deliberately no user FKs: the block and its attribution must survive
    // deletion of either the subject or the administrator who created it.
    userId: text("user_id").notNull(),
    normalizedEmail: varchar("normalized_email", { length: 320 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    blockedByUserId: text("blocked_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("user_blocks_user_id_idx").on(table.userId),
    uniqueIndex("user_blocks_normalized_email_idx").on(table.normalizedEmail),
    index("user_blocks_created_at_idx").on(table.createdAt.desc()),
    check(
      "user_blocks_normalized_email_check",
      sql`char_length(${table.normalizedEmail}) > 0 AND ${table.normalizedEmail} = lower(btrim(${table.normalizedEmail}))`,
    ),
    check("user_blocks_reason_check", sql`char_length(btrim(${table.reason})) BETWEEN 1 AND 500`),
  ],
);

export const blockedOauthAccounts = pgTable(
  "blocked_oauth_accounts",
  {
    blockId: uuid("block_id")
      .notNull()
      .references(() => userBlocks.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    accountId: text("account_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.providerId, table.accountId] }),
    index("blocked_oauth_accounts_block_id_idx").on(table.blockId),
    check("blocked_oauth_accounts_noncredential_check", sql`${table.providerId} <> 'credential'`),
  ],
);

export const draftVisibility = pgEnum("draft_visibility", ["public", "private", "password"]);
export const versionSource = pgEnum("version_source", ["browser", "api_token"]);

export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 80 }).notNull().unique(),
    title: varchar("title", { length: 200 }).notNull(),
    visibility: draftVisibility("visibility").notNull().default("private"),
    // Salted scrypt hash; set only when visibility is "password", null otherwise.
    passwordHash: text("password_hash"),
    currentVersionId: uuid("current_version_id").references((): AnyPgColumn => draftVersions.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [index("drafts_owner_updated_idx").on(table.ownerId, table.updatedAt.desc())],
);

export const draftVersions = pgTable(
  "draft_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    storageKey: text("storage_key").notNull(),
    contentSha256: char("content_sha256", { length: 64 }).notNull(),
    contentType: varchar("content_type", { length: 100 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    source: versionSource("source").notNull(),
    createdByTokenId: uuid("created_by_token_id").references(() => apiTokens.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("draft_versions_draft_id_version_number_idx").on(
      table.draftId,
      table.versionNumber,
    ),
  ],
);

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    tokenPrefix: varchar("token_prefix", { length: 20 }).notNull(),
    tokenHash: char("token_hash", { length: 64 }).notNull(),
    scopes: text("scopes").array().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("api_tokens_token_hash_idx").on(table.tokenHash),
    index("api_tokens_user_id_idx").on(table.userId),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Intentionally no FKs: audit history must survive deletion of its subjects.
    userId: text("user_id"),
    draftId: uuid("draft_id"),
    tokenId: uuid("token_id"),
    eventType: varchar("event_type", { length: 50 }).notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("audit_events_draft_id_idx").on(table.draftId)],
);

// Admin-managed runtime settings (e.g. "signups_enabled"). A missing key means
// the setting's default applies; see lib/settings/service.ts.
export const appSettings = pgTable("app_settings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const rateLimits = pgTable(
  "rate_limits",
  {
    // e.g. "uploads:10m:<userId>" or "pw:<draftId>:<clientHash>"; one row per window.
    key: varchar("key", { length: 120 }).notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.key, table.windowStart] }),
    index("rate_limits_expires_at_idx").on(table.expiresAt),
  ],
);

export type User = typeof users.$inferSelect;
export type Draft = typeof drafts.$inferSelect;
export type DraftVersion = typeof draftVersions.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type UserBlock = typeof userBlocks.$inferSelect;
export type Visibility = (typeof draftVisibility.enumValues)[number];
export type UserPlan = (typeof userPlan.enumValues)[number];
export type UserRole = (typeof userRole.enumValues)[number];
