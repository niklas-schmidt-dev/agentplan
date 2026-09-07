import { ApiError } from "./api.js";

export class CliError extends Error {
  constructor(
    message: string,
    public exitCode = 2,
    public code = "INVALID_ARGUMENT",
  ) {
    super(message);
  }
}

// Diagnostics can originate at custom servers. Do not echo credentials or signed URLs.
function redact(message: string): string {
  return message
    .replace(/ap_live_[A-Za-z0-9_-]+/g, "[redacted token]")
    .replace(/https?:\/\/[^\s]+/g, "[URL]");
}

export function writeError(error: unknown, json: boolean): number {
  const api = error instanceof ApiError ? error : null;
  const parsing =
    error instanceof Error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS");
  const code = redact(
    api?.code ??
      (error instanceof CliError ? error.code : parsing ? "INVALID_ARGUMENT" : "CLI_ERROR"),
  );
  const message = redact(
    parsing
      ? "Invalid command arguments. Run agentplan --help for supported options."
      : error instanceof Error
        ? error.message
        : "The command failed.",
  );
  const envelope = {
    error: {
      code,
      message,
      status: api?.status ?? null,
      requestId: api?.requestId ? redact(api.requestId) : null,
      retryAfter: api?.retryAfter ? redact(api.retryAfter) : null,
      ...(api?.intentId ? { intentId: api.intentId } : {}),
    },
  };
  process.stderr.write(
    json
      ? `${JSON.stringify(envelope)}\n`
      : `agentplan: ${code}: ${message}${api?.status === 401 ? " Run agentplan login with a valid token." : ""}\n`,
  );
  return error instanceof CliError ? error.exitCode : parsing ? 2 : 1;
}
