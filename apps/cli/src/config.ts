import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CliConfig {
  apiUrl: string;
  apiKey: string;
}

function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "faden", "config.json");
}

const DEFAULT_API_URL = "https://api.faden.io";

/**
 * Resolve credentials: `FADEN_API_KEY` / `FADEN_API_URL` env vars win (the natural fit for MCP
 * client configs and CI), falling back to the config file written by `faden login`.
 */
export async function loadConfig(): Promise<CliConfig> {
  if (process.env.FADEN_API_KEY) {
    return {
      apiKey: process.env.FADEN_API_KEY,
      apiUrl: (process.env.FADEN_API_URL ?? DEFAULT_API_URL).replace(/\/$/, ""),
    };
  }
  try {
    const raw = await readFile(configPath(), "utf8");
    return JSON.parse(raw) as CliConfig;
  } catch {
    throw new Error("not logged in — run `faden login` or set FADEN_API_KEY");
  }
}

export async function saveConfig(config: CliConfig): Promise<string> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  return path;
}
