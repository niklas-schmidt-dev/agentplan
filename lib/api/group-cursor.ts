import { createHash } from "node:crypto";
import { decodeDraftCursor, encodeDraftCursor, InvalidDraftCursorError } from "./draft-cursor";

export class InvalidGroupCursorError extends Error {
  constructor() {
    super("Invalid cursor. Start again from the first page with the selected filters.");
    this.name = "InvalidGroupCursorError";
  }
}
export function groupFilterKey(
  ownerId: string,
  filters: { parentId?: string | null; scope?: string; search?: string },
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "groups",
        ownerId,
        filters.parentId ?? null,
        filters.scope ?? "children",
        filters.search ?? "",
      ]),
    )
    .digest("hex");
}
export function decodeGroupCursor(value: string, filter: string) {
  try {
    const cursor = decodeDraftCursor(value, filter);
    if (cursor.direction !== "next") throw new InvalidGroupCursorError();
    return cursor;
  } catch (error) {
    if (error instanceof InvalidDraftCursorError) throw new InvalidGroupCursorError();
    throw error;
  }
}
export function encodeGroupCursor(at: string, id: string, filter: string) {
  return encodeDraftCursor({ at, id, filter, direction: "next" });
}
