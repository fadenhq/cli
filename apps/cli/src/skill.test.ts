import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ERROR_CODES } from "@fadenhq/shared";
import { describe, expect, it } from "vitest";
import { TOOLS } from "./mcp.js";

/**
 * The skill (`plugin/skills/faden/SKILL.md`) is documentation an agent executes, so a command
 * renamed here becomes a wrong instruction shipped to every install — and unlike a README,
 * nobody re-reads it. These tests fail the build instead: whatever the skill tells an agent to
 * run has to exist.
 *
 * Installed copies go stale independently of this (`npx skills add` copies the file, `npx skills
 * update` refreshes it) — that half is the user's. This half is ours: what we publish is true.
 */

const execFileAsync = promisify(execFile);
const CLI_DIR = fileURLToPath(new URL("..", import.meta.url));
// Same relative layout in this monorepo and in the public fadenhq/cli mirror.
const SKILL = readFileSync(new URL("../../../plugin/skills/faden/SKILL.md", import.meta.url), "utf8");

/** Command paths the skill tells an agent to run, e.g. "posts create" from `npx @fadenhq/cli posts create -p …`. */
function referencedCommands(): string[] {
  const found = new Set<string>();
  for (const match of SKILL.matchAll(/npx @fadenhq\/cli ((?:[a-z][a-z-]*\s+){0,1}[a-z][a-z-]*)/g)) {
    found.add(match[1]!.trim().split(/\s+/).slice(0, 2).join(" "));
  }
  return [...found];
}

/**
 * Every snake_case identifier the skill mentions. The skill talks about two kinds — MCP tools it
 * tells the agent to call, and `error_code` values it tells the agent to react to — so the
 * assertion is that each one is *one of those*, checked against the registry and the shared enum.
 * An identifier that is neither is either a typo or something renamed out from under the skill.
 */
function referencedIdentifiers(): string[] {
  return [...new Set([...SKILL.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)].map((m) => m[0]))];
}

/** Subcommand names commander lists under a parent's `Commands:` heading. */
async function listedCommands(parent: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync("node", ["--import", "tsx", "src/index.ts", ...parent, "--help"], {
    cwd: CLI_DIR,
  });
  const section = stdout.split(/^Commands:$/m)[1] ?? "";
  // Entries start at a fixed indent; wrapped description lines are indented further. A command
  // with aliases is listed as `login|setup`, and every spelling of it counts as existing.
  return [...section.matchAll(/^ {2}(\S+)/gm)].flatMap((m) => m[1]!.split("|"));
}

describe("the plugin ships as a version of the CLI", () => {
  // The plugin is how Claude Code installs the MCP server, which *is* the CLI — so a plugin
  // version that lags the release it carries is a version number that means nothing. Claude
  // Code shows it in `/plugin`, making it the only version a user of the plugin can see.
  it("declares the same version as the package it runs", () => {
    const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as { version: string };
    expect(read("../../../plugin/.claude-plugin/plugin.json").version).toBe(read("../package.json").version);
  });
});

describe("the faden skill stays true to the CLI", () => {
  // A regex that quietly stopped matching would make every assertion below vacuous.
  it("extracts what it claims to (guards the guards)", () => {
    expect(referencedCommands()).toContain("posts create");
    expect(referencedCommands()).toContain("platforms list");
    expect(referencedIdentifiers()).toContain("create_post");
    expect(referencedIdentifiers()).toContain("content_too_long");
  });

  it("names only MCP tools that exist, or error codes that do", () => {
    const known = new Set<string>([
      ...TOOLS.map((t) => t.name),
      ...ERROR_CODES,
      // Validation-issue codes (packages/shared validate.ts) and prose the pattern also catches.
      "content_too_long",
      "too_many_media",
      "media_required",
      "media_unsupported",
      "media_too_large",
      "media_too_long",
      "board_required",
      "location_required",
      "validation_failed",
      "account_not_connected",
      "drafts_only", // API 403 for a key in a drafts-only workspace (#164)
      "account_reconnect_required", // pre-flight issue for a grant missing media scopes (#157)
      "media_in_use", // API 409 from DELETE /v1/media/:id
      "google_business",
      "fdn_live_",
    ]);
    expect(referencedIdentifiers().filter((name) => !known.has(name))).toEqual([]);
  });

  it("runs only commands the CLI actually has", async () => {
    const missing: string[] = [];
    const groups = new Map<string, string[]>();
    for (const command of referencedCommands()) {
      const words = command.split(" ");
      const parent = words.slice(0, -1).join(" ");
      groups.set(parent, [...(groups.get(parent) ?? []), words[words.length - 1]!]);
    }
    // `--help` alone cannot answer this: commander short-circuits on it and exits 0 even for a
    // command it does not have, so ask the parent what it lists instead.
    for (const [parent, children] of groups) {
      const listed = new Set(await listedCommands(parent === "" ? [] : parent.split(" ")));
      missing.push(...children.filter((c) => !listed.has(c)).map((c) => `${parent} ${c}`.trim()));
    }
    expect(missing).toEqual([]);
  }, 30_000);
});
