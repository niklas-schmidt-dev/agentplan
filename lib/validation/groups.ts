import { z } from "zod";
const groupUuid = z.uuid().transform((id) => id.toLowerCase());

const groupFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  parentId: groupUuid.nullable().optional(),
};
export const createGroupSchema = z.object(groupFields).strict();
export const patchGroupSchema = z
  .object({ ...groupFields, name: groupFields.name.optional() })
  .strict()
  .refine(
    (input) => Object.values(input).some((value) => value !== undefined),
    "Provide at least one group field.",
  );
export const listGroupsQuerySchema = z.object({
  parentId: groupUuid.optional(),
  scope: z.enum(["children", "subtree"]).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).max(1024).optional(),
});
export const moveDraftsSchema = z
  .object({
    draftIds: z
      .array(groupUuid)
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, "Duplicate draft IDs are not allowed."),
    groupId: groupUuid.nullable(),
  })
  .strict();
