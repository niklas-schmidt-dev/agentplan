import { MIN_DRAFT_EXPIRY_SECONDS, MAX_DRAFT_EXPIRY_SECONDS } from "@agentplan/upload-contract";
import { z } from "zod";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/drafts/password";
import { TOKEN_SCOPES } from "@/lib/tokens/token";

export const draftExpirySchema = z
  .number()
  .int()
  .min(MIN_DRAFT_EXPIRY_SECONDS)
  .max(MAX_DRAFT_EXPIRY_SECONDS)
  .nullable()
  .optional();

export const visibilitySchema = z.enum(["public", "private", "password"]);

export const uuidSchema = z.uuid();

export const draftPasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(MAX_PASSWORD_LENGTH);

export const draftFieldsSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    visibility: visibilitySchema.optional(),
    password: draftPasswordSchema.optional(),
  })
  .refine(
    (value) =>
      value.password === undefined ||
      value.visibility === undefined ||
      value.visibility === "password",
    { message: "A password cannot be combined with public or private visibility." },
  );

// The schema validates shape only. Requiring a password when switching to
// password visibility is enforced in the service layer, where the draft's
// existing hash (if any) is known.
export const patchDraftSchema = draftFieldsSchema.refine(
  (value) =>
    value.title !== undefined || value.visibility !== undefined || value.password !== undefined,
  { message: "Provide at least one of: title, visibility, password." },
);

export const listDraftsQuerySchema = z
  .object({
    groupId: z
      .union([z.uuid(), z.literal("none")])
      .optional()
      .transform((value) => (value === "none" ? null : value)),
    includeDescendants: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
    search: z.string().trim().min(1).max(200).optional(),
    visibility: visibilitySchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .refine(
    (input) => !input.includeDescendants || Boolean(input.groupId),
    "Including subgroups requires a group.",
  );

export const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z
    .array(z.enum(TOKEN_SCOPES))
    .min(1)
    .default([...TOKEN_SCOPES]),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});
