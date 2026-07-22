import { z } from "zod";
import { TOKEN_SCOPES } from "@/lib/tokens/token";

export const visibilitySchema = z.enum(["public", "private"]);

export const uuidSchema = z.uuid();

export const draftFieldsSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  visibility: visibilitySchema.optional(),
});

export const patchDraftSchema = draftFieldsSchema.refine(
  (value) => value.title !== undefined || value.visibility !== undefined,
  { message: "Provide at least one of: title, visibility." },
);

export const listDraftsQuerySchema = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  visibility: visibilitySchema.optional(),
});

export const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(TOKEN_SCOPES)).min(1).default([...TOKEN_SCOPES]),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});
