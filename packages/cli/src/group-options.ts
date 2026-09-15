import { CliError } from "./errors.js";

export type GroupFlags = {
  json?: boolean;
  group?: string;
  ungrouped?: boolean;
  parent?: string;
  root?: boolean;
  recursive?: boolean;
  description?: string;
  yes?: boolean;
  limit?: string;
  cursor?: string;
  search?: string;
};

export function requireUuid(value: string | undefined, label: string): string {
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new CliError(`${label} must be a UUID.`);
  return value;
}

export function draftGroupTarget(flags: GroupFlags, required = false): string | null | undefined {
  if (flags.group !== undefined && flags.ungrouped)
    throw new CliError("Use only one of --group or --ungrouped.");
  if (flags.group !== undefined) return requireUuid(flags.group, "--group");
  if (flags.ungrouped) return null;
  if (required) throw new CliError("Provide --group <id> or --ungrouped.");
  return undefined;
}

export function groupParentTarget(flags: GroupFlags): string | null {
  if (flags.parent !== undefined && flags.root)
    throw new CliError("Use only one of --parent or --root.");
  if (flags.parent !== undefined) return requireUuid(flags.parent, "--parent");
  if (flags.root) return null;
  throw new CliError("Provide --parent <id> or --root.");
}

export function groupListOptions(flags: GroupFlags) {
  return {
    ...paginationOptions(flags),
    parentId: flags.parent === undefined ? undefined : requireUuid(flags.parent, "--parent"),
    scope: flags.recursive ? ("subtree" as const) : ("children" as const),
  };
}

export function draftGroupFilters(flags: GroupFlags) {
  const groupId = draftGroupTarget(flags);
  if (flags.recursive && !groupId) throw new CliError("--recursive requires --group <id>.");
  return {
    groupId: groupId === null ? "none" : groupId,
    includeDescendants: flags.recursive ? true : undefined,
  };
}

export function paginationOptions(flags: GroupFlags) {
  const limit = flags.limit === undefined ? undefined : Number(flags.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200))
    throw new CliError("--limit must be an integer from 1 to 200.");
  if (flags.cursor !== undefined && (!flags.cursor || flags.cursor.length > 1024))
    throw new CliError("--cursor must contain 1 to 1024 characters.");
  const search = flags.search?.trim();
  if (search !== undefined && (!search || search.length > 200))
    throw new CliError("--search must contain 1 to 200 characters.");
  return { limit, cursor: flags.cursor, search };
}
