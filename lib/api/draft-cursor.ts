import { createHash } from "node:crypto";
import { z } from "zod";

const cursorSchema = z
  .object({
    v: z.literal(1),
    at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
      .refine((value) => Number.isFinite(Date.parse(value))),
    id: z.uuid(),
    filter: z.string().length(64),
    direction: z.enum(["next", "previous"]),
  })
  .strict();
export type DraftCursor = z.infer<typeof cursorSchema>;
export class InvalidDraftCursorError extends Error {
  constructor() {
    super("Invalid cursor. Start again from the first page with the selected filters.");
  }
}

export function draftFilterKey(
  ownerId: string,
  filters: {
    search?: string;
    visibility?: string;
    updatedWithinDays?: number;
  },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        ownerId,
        filters.search ?? "",
        filters.visibility ?? "",
        filters.updatedWithinDays ?? null,
      ]),
    )
    .digest("hex");
}

export function encodeDraftCursor(cursor: Omit<DraftCursor, "v">): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor })).toString("base64url");
}

export function decodeDraftCursor(value: string, filter: string): DraftCursor {
  try {
    if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (cursor.filter !== filter) throw new Error();
    return cursor;
  } catch {
    throw new InvalidDraftCursorError();
  }
}
