import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type CliConfig = {
  token?: string;
  apiUrl?: string;
};

/** OS configuration directory — never the project directory. */
export function configDir(): string {
  if (process.platform === "win32") {
    const base = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "agentplan");
  }
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "agentplan");
}

function configPath(): string {
  return path.join(configDir(), "config.json");
}

export async function loadConfig(): Promise<CliConfig> {
  try {
    const raw = await readFile(configPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    return {
      token: typeof record.token === "string" ? record.token : undefined,
      apiUrl: typeof record.apiUrl === "string" ? record.apiUrl : undefined,
    };
  } catch {
    return {};
  }
}

export async function saveConfig(config: CliConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") {
    // writeFile's mode only applies on creation; enforce on every save.
    await chmod(configPath(), 0o600);
  }
}

export async function clearConfig(): Promise<void> {
  await rm(configPath(), { force: true });
}
