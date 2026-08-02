import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError, EXIT } from "./exit.js";

export interface CliConfig {
  apiUrl: string;
  apiKey: string;
}

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "faden", "config.json");
}

export const DEFAULT_API_URL = "https://api.faden.io";

/** Where the active credentials came from — reported by `faden whoami`. */
export type ConfigSource = "env" | "file";

export interface ResolvedConfig extends CliConfig {
  source: ConfigSource;
}

/**
 * Resolve credentials: `FADEN_API_KEY` / `FADEN_API_URL` env vars win (the natural fit for MCP
 * client configs and CI), falling back to the config file written by `faden login`.
 */
export async function loadConfig(): Promise<ResolvedConfig> {
  if (process.env.FADEN_API_KEY) {
    return {
      apiKey: process.env.FADEN_API_KEY,
      apiUrl: (process.env.FADEN_API_URL ?? DEFAULT_API_URL).replace(/\/$/, ""),
      source: "env",
    };
  }
  try {
    const raw = await readFile(configPath(), "utf8");
    return { ...(JSON.parse(raw) as CliConfig), source: "file" };
  } catch {
    throw new CliError(
      "not logged in. Run `faden login`, or set FADEN_API_KEY for a non-interactive environment",
      EXIT.auth,
    );
  }
}

export async function saveConfig(config: CliConfig): Promise<string> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  return path;
}
