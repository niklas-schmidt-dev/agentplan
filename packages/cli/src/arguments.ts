import { parseArgs } from "node:util";
import { CliError } from "./errors.js";

export function parseCommand(args: string[]) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        public: { type: "boolean" },
        private: { type: "boolean" },
        password: { type: "string" },
        "password-stdin": { type: "boolean" },
        title: { type: "string" },
        "expires-in": { type: "string" },
        draft: { type: "string" },
        entry: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        limit: { type: "string" },
        cursor: { type: "string" },
        search: { type: "string" },
        visibility: { type: "string" },
        yes: { type: "boolean" },
        bundle: { type: "boolean" },
        complete: { type: "boolean" },
        group: { type: "string" },
        ungrouped: { type: "boolean" },
        parent: { type: "string" },
        root: { type: "boolean" },
        recursive: { type: "boolean" },
        description: { type: "string" },
      },
      allowPositionals: true,
      tokens: true,
    });
  } catch {
    // parseArgs diagnostics can include the original argument value.
    throw new CliError("Invalid command arguments. Run agentplan --help for supported options.");
  }
  const { values, positionals, tokens } = parsed;
  const [command, argument] = positionals;
  if (values.help || !command) return { values, positionals };
  const allowed: Record<string, string[]> = {
    login: [],
    logout: [],
    upload: [
      "expires-in",
      "public",
      "private",
      "password",
      "password-stdin",
      "title",
      "draft",
      "entry",
      "group",
    ],
    list: ["limit", "cursor", "search", "visibility", "group", "ungrouped", "recursive"],
    open: [],
    validate: ["entry"],
    get: [],
    versions: [],
    update: ["title", "public", "private", "password", "password-stdin"],
    restore: [],
    delete: ["yes"],
    "upload-status": ["bundle", "complete"],
    move: ["group", "ungrouped"],
    "groups create": ["parent", "description"],
    "groups list": ["parent", "recursive", "search", "limit", "cursor"],
    "groups move": ["parent", "root"],
    "groups dissolve": ["yes"],
  };
  const name = command === "groups" ? `groups ${argument ?? ""}`.trim() : command;
  if (!allowed[name]) throw new CliError(`Unknown command: ${name}`);
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new CliError(`--${token.name} may only be provided once.`);
    seen.add(token.name);
    if (!["json", "help", ...allowed[name]].includes(token.name))
      throw new CliError(`--${token.name} is not supported for ${name}.`);
  }
  const maxArguments =
    command === "groups"
      ? argument === "list"
        ? 2
        : 3
      : command === "move"
        ? 51
        : command === "restore"
          ? 3
          : ["login", "logout", "list"].includes(command)
            ? 1
            : 2;
  if (positionals.length > maxArguments) throw new CliError(`Too many arguments for ${name}.`);
  if (command === "groups" && argument !== "list" && positionals.length !== 3)
    throw new CliError(`Usage: agentplan ${name} ${argument === "create" ? "<name>" : "<id>"}`);
  if (command === "move" && positionals.length < 2)
    throw new CliError(
      "Usage: agentplan move <draft-id> [<draft-id> ...] --group <id> | --ungrouped",
    );
  return { values, positionals };
}
