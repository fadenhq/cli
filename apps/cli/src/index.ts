#!/usr/bin/env node
import { createRequire } from "node:module";
import {
  CREDENTIAL_CONNECT_PLATFORMS,
  isPlatform,
  PLATFORM_CONSTRAINTS,
  PLATFORMS,
  type Platform,
  type PublishOptions,
  WEBHOOK_DELIVERY_RETENTION_DAYS,
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_EVENTS,
  WEBHOOK_FAILURE_THRESHOLD,
} from "@fadenhq/shared";
import { Command } from "commander";
import { ApiClient, ApiError, resolveTimeoutMs } from "./client.js";
import { loadConfig, saveConfig, type ResolvedConfig } from "./config.js";
import { CliError, EXIT, EXIT_CODE_HELP } from "./exit.js";
import { isIndirect, resolveInput } from "./input.js";
import { uploadMedia } from "./media.js";
import { configureOutput, emit, hint } from "./output.js";
import { formatPreflight, preflight } from "./preflight.js";
import { toIsoUtc } from "./time.js";

const version = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

const program = new Command();
program
  .name("faden")
  .description("Unified social-media publishing CLI")
  .version(version)
  .option("--output <format>", "json or text (default: text on a terminal, json when piped)")
  .option("--timeout <ms>", "per-request timeout in milliseconds, or 0 to disable it", (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new CliError(`--timeout must be a non-negative number, got: ${v}`, EXIT.validation);
    return n;
  })
  .option("--no-hints", "suppress the suggested next commands written to stderr")
  .addHelpText(
    "after",
    `
Examples:
  faden login                                        browser login, or --key for CI
  faden posts create -p x,linkedin -c "Shipping today"
  faden posts create -p x -c "…" --dry-run           validate offline, publish nothing
  faden posts list --status scheduled
  faden platforms list                               limits per platform, no API call

Environment:
  FADEN_API_KEY      workspace key; skips the config file entirely
  FADEN_API_URL      API base URL (default https://api.faden.io)
  FADEN_TIMEOUT_MS   default request timeout
  FADEN_NO_HINTS     set to any value to suppress next-command hints

${EXIT_CODE_HELP}

Docs: https://faden.io/docs   MCP server: faden mcp`,
  );

interface GlobalOptions {
  output?: string;
  timeout?: number;
  hints: boolean;
}

/** Global flags are resolved once, before any action runs. */
program.hook("preAction", () => {
  const opts = program.opts<GlobalOptions>();
  configureOutput({ output: opts.output, noHints: !opts.hints });
});

async function client(): Promise<ApiClient> {
  const opts = program.opts<GlobalOptions>();
  return new ApiClient(await loadConfig(), resolveTimeoutMs(opts.timeout));
}

function parsePlatforms(value: string): Platform[] {
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((p) => !isPlatform(p));
  if (bad.length > 0) {
    throw new CliError(`unknown platform(s): ${bad.join(", ")}. Valid: ${PLATFORMS.join(", ")}`, EXIT.validation);
  }
  return list as Platform[];
}

// ---------------------------------------------------------------------------
// login / whoami
// ---------------------------------------------------------------------------

/** True when there is no human who could complete a browser flow. */
function isNonInteractive(): boolean {
  return !process.stdout.isTTY || Boolean(process.env.CI);
}

program
  .command("login")
  .alias("setup")
  .description("Log in via the browser and mint a workspace API key (or pass --key to store one directly)")
  .option("-u, --url <url>", "API base URL", "https://api.faden.io")
  .option("-k, --key <apiKey>", "workspace API key (fdn_live_…), skipping the browser flow")
  .option("--app <url>", "dashboard base URL (for the browser flow)", "https://app.faden.io")
  .addHelpText(
    "after",
    `
Examples:
  faden login                                    opens a browser, mints a key for this machine
  faden login --key fdn_live_xxx                 store an existing key, no browser
  export FADEN_API_KEY=fdn_live_xxx              no login at all; env beats the config file

The browser flow needs an interactive terminal. In CI or an agent sandbox, use --key or
FADEN_API_KEY. Create a key at https://app.faden.io/settings/keys.`,
  )
  .action(async (opts: { url: string; key?: string; app: string }) => {
    let apiKey = opts.key;
    let workspace: string | undefined;
    if (!apiKey) {
      // Failing here in ~0ms beats blocking an agent for the browser flow's five-minute timeout.
      if (isNonInteractive()) {
        throw new CliError(
          "browser login needs an interactive terminal. Use a key instead:\n" +
            "  faden login --key fdn_live_<key>\n" +
            "  export FADEN_API_KEY=fdn_live_<key>\n" +
            "Create a key at https://app.faden.io/settings/keys",
          EXIT.auth,
        );
      }
      const { browserLogin } = await import("./browser-login.js");
      ({ apiKey, workspace } = await browserLogin(opts.app.replace(/\/$/, "")));
    }
    const path = await saveConfig({ apiUrl: opts.url.replace(/\/$/, ""), apiKey });
    emit(
      { ok: true, configPath: path, apiUrl: opts.url.replace(/\/$/, ""), workspace: workspace ?? null },
      (d: { configPath: string; workspace: string | null }) =>
        `Logged in${d.workspace ? ` to workspace "${d.workspace}"` : ""}. Credentials saved to ${d.configPath}`,
    );
    hint("faden whoami", "faden accounts list");
  });

/** Never print more of a secret than is needed to tell two keys apart, and never overlapping ends. */
function maskKey(key: string): string {
  if (key.length > 20) return `${key.slice(0, 12)}…${key.slice(-4)}`;
  return `${key.slice(0, Math.min(8, Math.floor(key.length / 2)))}…`;
}

program
  .command("whoami")
  .description("Show the active credentials and workspace, verifying them against the API")
  .addHelpText(
    "after",
    `
Examples:
  faden whoami                    exits 2 when not authenticated
  faden whoami --output json | jq -r .workspace.id`,
  )
  .action(async () => {
    const config: ResolvedConfig = await loadConfig();
    const api = new ApiClient(config, resolveTimeoutMs(program.opts<GlobalOptions>().timeout));
    // /v1/whoami, not /v1/me: the CLI authenticates with a workspace API key, which carries no
    // user identity — /v1/me is the dashboard's session-only bootstrap and rejects keys.
    const me = await api
      .get<{ workspace?: { id: string; name: string; plan: string } }>("/v1/whoami")
      .catch((err: unknown) => {
        // Deployments older than 2026-07-26 have no /v1/whoami at all, and answer with the
        // router's own 404 rather than the endpoint's `not_found`. Say that outright: a bare
        // 404 here reads like the *key* is missing, which sends people re-running login.
        if (err instanceof ApiError && err.status === 404 && err.body.error !== "not_found") {
          throw new CliError(
            `${config.apiUrl} has no /v1/whoami, so that API deployment predates this command.\n` +
              "Upgrade the API deployment (or check FADEN_API_URL points at the API host).",
            EXIT.generic,
          );
        }
        throw err;
      });
    emit(
      { apiUrl: config.apiUrl, keySource: config.source, apiKey: maskKey(config.apiKey), ...me },
      (d: { apiUrl: string; keySource: string; apiKey: string; workspace?: { id: string; name: string; plan: string } }) =>
        [
          `key        ${d.apiKey} (from ${d.keySource === "env" ? "FADEN_API_KEY" : "config file"})`,
          `api        ${d.apiUrl}`,
          ...(d.workspace
            ? [`workspace  ${d.workspace.name} (${d.workspace.id})`, `plan       ${d.workspace.plan}`]
            : []),
        ].join("\n"),
    );
  });

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

const accounts = program.command("accounts").description("Manage connected social accounts");

accounts
  .command("connect <platform>")
  .description("Connect a social account (returns an OAuth URL to open, except Bluesky, which uses an app password)")
  .option("--identifier <identifier>", "account handle/email (credential platforms, e.g. bluesky)")
  .option("--app-password <password>", "app password from the platform's settings (credential platforms)")
  .addHelpText(
    "after",
    `
Examples:
  faden accounts connect x                       prints an authUrl to open in a browser
  faden accounts connect bluesky --identifier you.bsky.social --app-password xxxx-xxxx-xxxx-xxxx`,
  )
  .action(async (platform: string, opts: { identifier?: string; appPassword?: string }) => {
    if (!isPlatform(platform)) {
      throw new CliError(`unknown platform: ${platform}. Valid: ${PLATFORMS.join(", ")}`, EXIT.validation);
    }
    const api = await client();

    if ((CREDENTIAL_CONNECT_PLATFORMS as readonly string[]).includes(platform)) {
      if (!opts.identifier || !opts.appPassword) {
        throw new CliError(
          `${platform} connects with an app password, not OAuth:\n` +
            `  faden accounts connect ${platform} --identifier you.bsky.social --app-password xxxx-xxxx-xxxx-xxxx\n` +
            `Create one at bsky.app → Settings → Privacy and Security → App Passwords.`,
          EXIT.validation,
        );
      }
      const res = await api.post<{ accounts: string[] }>(`/v1/accounts/${platform}/connect`, {
        identifier: opts.identifier,
        appPassword: opts.appPassword,
      });
      emit(res, (d: { accounts: string[] }) => `Connected: ${d.accounts.join(", ")}`);
      hint("faden accounts list");
      return;
    }

    // No returnTo: the API then shows a confirmation page naming the workspace after consent.
    // (returnTo binds the flow to the browser that called connect, which a CLI is not.)
    const res = await api.post<{ authUrl: string }>(`/v1/accounts/${platform}/connect`);
    emit(res, (d: { authUrl: string }) => `Open this URL in your browser to authorize:\n\n${d.authUrl}`);
    hint("faden accounts list   # once the browser flow completes");
  });

accounts
  .command("list")
  .description("List connected accounts (id, handle, displayName, status)")
  .addHelpText(
    "after",
    `
Examples:
  faden accounts list
  faden accounts list | jq -r '.[] | select(.platform=="x") | .id'`,
  )
  .action(async () => {
    const api = await client();
    const res = await api.get<{ accounts: unknown[] }>("/v1/accounts");
    emit(res.accounts);
    hint("faden posts create -p x -c \"…\"", "faden accounts rename <accountId> <handle>");
  });

accounts
  .command("rename <accountId> <handle>")
  .description("Set an account's handle, the slug that targets it in --accounts (lowercase letters, digits, hyphens)")
  .addHelpText(
    "after",
    `
Examples:
  faden accounts rename acc_123 main-brand
  faden posts create -p x --accounts main-brand -c "targeted at one account"`,
  )
  .action(async (accountId: string, handle: string) => {
    const api = await client();
    emit(await api.patch(`/v1/accounts/${accountId}`, { handle }));
  });

accounts
  .command("boards <accountId>")
  .description("List an account's publish destinations (Pinterest boards via --board, Google Business locations via --location)")
  .addHelpText(
    "after",
    `
Examples:
  faden accounts boards acc_123
  faden posts create -p pinterest -c "Pin it" -m https://cdn.example/a.jpg --board <boardId>`,
  )
  .action(async (accountId: string) => {
    const api = await client();
    const res = await api.get<{ boards: unknown[] }>(`/v1/accounts/${accountId}/boards`);
    emit(res.boards);
  });

// ---------------------------------------------------------------------------
// shared post-body helpers
// ---------------------------------------------------------------------------

/** Split a comma-separated option value into a trimmed, non-empty list. */
function parseCommaList(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Repeatable `--caption platform=text` collector. */
function collectCaption(value: string, prev: Record<string, string>): Record<string, string> {
  const eq = value.indexOf("=");
  const platform = eq === -1 ? "" : value.slice(0, eq).trim();
  if (!isPlatform(platform)) {
    throw new CliError(`--caption expects <platform>=<text> with a valid platform, got: ${value}`, EXIT.validation);
  }
  return { ...prev, [platform]: value.slice(eq + 1) };
}

/** `--config` escape hatch: raw JSON with platformConfigurations / accountConfigurations. */
function parseConfigJson(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CliError(`--config must be valid JSON (or "@file.json" / "-" for stdin)`, EXIT.validation);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError('--config must be a JSON object like {"platformConfigurations": {...}}', EXIT.validation);
  }
  return parsed as Record<string, unknown>;
}

/** Merge --caption/--config into the request body's configuration fields. */
function applyConfigOptions(
  body: Record<string, unknown>,
  opts: { caption?: Record<string, string>; config?: Record<string, unknown> },
): void {
  if (opts.config) {
    if (opts.config.platformConfigurations) body.platformConfigurations = opts.config.platformConfigurations;
    if (opts.config.accountConfigurations) body.accountConfigurations = opts.config.accountConfigurations;
  }
  if (opts.caption && Object.keys(opts.caption).length > 0) {
    const platformCfg = { ...(body.platformConfigurations as Record<string, Record<string, unknown>> | undefined) };
    for (const [platform, content] of Object.entries(opts.caption)) {
      platformCfg[platform] = { ...platformCfg[platform], content };
    }
    body.platformConfigurations = platformCfg;
  }
}

function setPlatformOption(body: Record<string, unknown>, platform: string, key: string, value: string): void {
  const platformCfg = { ...(body.platformConfigurations as Record<string, Record<string, unknown>> | undefined) };
  platformCfg[platform] = { ...platformCfg[platform], [key]: value };
  body.platformConfigurations = platformCfg;
}

/**
 * `--content` and `--config` accept a literal, `-` for stdin, or `@path` for a file — the same
 * convention everywhere, so pipelines compose without shell-escaping multi-line text. Both stay
 * unparsed strings until here: a commander option parser runs too early to reach a file or stdin.
 */
async function resolveContentOptions(opts: {
  content?: string;
  config?: string;
}): Promise<{ content?: string; config?: Record<string, unknown> }> {
  const content = isIndirect(opts.content) ? await resolveInput(opts.content as string) : opts.content;
  const config = opts.config === undefined ? undefined : parseConfigJson(await resolveInput(opts.config));
  return { content, config };
}

interface PostOptions {
  platforms: Platform[];
  content: string;
  accounts?: string[];
  media?: string[];
  at?: string;
  queue: boolean;
  draft: boolean;
  caption: Record<string, string>;
  board?: string;
  location?: string;
  config?: string;
  dryRun: boolean;
  idempotencyKey?: string;
}

/**
 * `faden posts create`, also reachable as `faden post`. Both names build the same Command so the
 * legacy top-level verb cannot drift from the canonical resource-first form.
 */
function makePostCreateCommand(name: string, aliasNote = ""): Command {
  return new Command(name)
    .description(`Publish or schedule a post across platforms${aliasNote}`)
    .requiredOption("-p, --platforms <list>", "comma-separated platforms", parsePlatforms)
    .option("-c, --content <text>", 'post text, or "-" for stdin and "@file.txt" for a file', "")
    .option("--accounts <refs>", "comma-separated account ids or handles to narrow the fan-out (default: every account of each platform)", parseCommaList)
    .option("-m, --media <urls>", "comma-separated public media URLs", (v) => v.split(",").map((s) => s.trim()).filter(Boolean))
    .option("--at <when>", 'schedule time, e.g. "2026-07-01T09:00 America/New_York" or ISO 8601')
    .option("--queue", "schedule into the next free posting-queue slot (see: faden queue)", false)
    .option("--draft", "store as a draft (do not auto-publish)", false)
    .option("--caption <platform=text>", "per-platform caption override (repeatable)", collectCaption, {})
    .option("--board <boardId>", "Pinterest destination board (see: faden accounts boards <accountId>)")
    .option("--location <locationId>", "Google Business destination location (see: faden accounts boards <accountId>)")
    .option("--config <json>", 'platformConfigurations/accountConfigurations as JSON, or "@file.json" or "-"')
    .option("--dry-run", "validate locally and print the request body, publishing nothing", false)
    .option(
      "--idempotency-key <key>",
      "retry-safe key: replaying it returns the original post instead of publishing twice",
    )
    .addHelpText(
      "after",
      `
Examples:
  faden ${name} -p x,linkedin -c "Shipping today"
  faden ${name} -p x -c "…" --at "2026-07-01T09:00 America/New_York"
  faden ${name} -p x,linkedin -c "Long version" --caption x="Short punchy version"
  faden ${name} -p pinterest -c "Pin it" -m https://cdn.example/a.jpg --board <boardId>
  faden ${name} -p x -c - < announcement.txt          multi-line text without shell escaping
  faden ${name} -p x -c "…" --dry-run                 offline validation, zero API calls
  faden ${name} -p x -c "…" --idempotency-key ship-42 safe to retry after a timeout
  faden ${name} -p x,linkedin -c "for review" --draft then: faden posts approve <postId>`,
    )
    .action(async (opts: PostOptions) => {
      const resolved = await resolveContentOptions(opts);
      const content = resolved.content ?? "";

      const body: Record<string, unknown> = {
        content,
        platforms: opts.platforms,
        mediaUrls: opts.media ?? [],
        draft: opts.draft,
      };
      if (opts.accounts) body.accountIds = opts.accounts;
      if (opts.queue) body.useQueue = true;
      if (opts.at) {
        const { scheduledFor, timezone } = toIsoUtc(opts.at);
        body.scheduledFor = scheduledFor;
        if (timezone) body.timezone = timezone;
      }
      applyConfigOptions(body, { caption: opts.caption, config: resolved.config });
      if (opts.board) setPlatformOption(body, "pinterest", "boardId", opts.board);
      if (opts.location) setPlatformOption(body, "google_business", "locationId", opts.location);

      if (opts.dryRun) {
        const platformCfg = (body.platformConfigurations ?? {}) as Partial<Record<Platform, PublishOptions>>;
        const result = preflight(opts.platforms, content, (opts.media ?? []) as string[], platformCfg);
        emit({ dryRun: true, ...result, request: { method: "POST", path: "/v1/posts", body } }, () =>
          `${formatPreflight(result)}\n\nwould POST /v1/posts\n${JSON.stringify(body, null, 2)}`,
        );
        if (!result.ok) process.exitCode = EXIT.validation;
        return;
      }

      const api = await client();
      const res = await api.post<{ postId: string; replayed?: boolean }>("/v1/posts", body, {
        headers: opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : undefined,
      });
      emit(res);
      hint(`faden posts get ${res.postId}`, `faden posts analytics ${res.postId}`);
    });
}

// ---------------------------------------------------------------------------
// posts
// ---------------------------------------------------------------------------

const postsCmd = program.command("posts").description("Create, inspect and manage posts");

postsCmd.addCommand(makePostCreateCommand("create"));
program.addCommand(makePostCreateCommand("post", " (alias for `faden posts create`)"));

function makePostsGetCommand(name: string, aliasNote = ""): Command {
  return new Command(name)
    .argument("<postId>")
    .description(`Show a post's status and per-platform results${aliasNote}`)
    .addHelpText(
      "after",
      `
Examples:
  faden posts ${name === "get" ? "get" : name} pst_abc123
  faden posts get pst_abc123 | jq -r '.targets[] | "\\(.platform) \\(.status)"'`,
    )
    .action(async (postId: string) => {
      const api = await client();
      emit(await api.get(`/v1/posts/${postId}`));
      hint(`faden posts analytics ${postId}`, `faden posts edit ${postId} -c "…"`);
    });
}

postsCmd.addCommand(makePostsGetCommand("get"));
program.addCommand(makePostsGetCommand("status", " (alias for `faden posts get`)"));

postsCmd
  .command("list")
  .description("List posts, newest first")
  .option("--status <status>", "filter: draft|scheduled|publishing|completed|partial|failed")
  .option("--platform <platform>", "filter by target platform")
  .option("--from <iso>", "createdAt lower bound (inclusive, ISO 8601)")
  .option("--to <iso>", "createdAt upper bound (exclusive, ISO 8601)")
  .option("--scheduled-from <iso>", "scheduledFor lower bound (inclusive, ISO 8601)")
  .option("--scheduled-to <iso>", "scheduledFor upper bound (exclusive, ISO 8601)")
  .option("--limit <n>", "page size (max 100)", "20")
  .option("--cursor <cursor>", "pagination cursor from the previous page")
  .option("--all", "follow the cursor and return every matching post", false)
  .addHelpText(
    "after",
    `
Examples:
  faden posts list --status scheduled
  faden posts list --platform x --limit 100
  faden posts list --status failed --all           follows the cursor for you
  faden posts list --from 2026-07-01T00:00:00Z --to 2026-08-01T00:00:00Z
  faden posts list --scheduled-from 2026-08-01T00:00:00Z --scheduled-to 2026-09-01T00:00:00Z
                                                   what goes out in August`,
  )
  .action(
    async (opts: {
      status?: string;
      platform?: string;
      from?: string;
      to?: string;
      scheduledFrom?: string;
      scheduledTo?: string;
      limit: string;
      cursor?: string;
      all: boolean;
    }) => {
      const api = await client();
      const query = new URLSearchParams();
      if (opts.status) query.set("status", opts.status);
      if (opts.platform) query.set("platform", opts.platform);
      if (opts.from) query.set("from", opts.from);
      if (opts.to) query.set("to", opts.to);
      if (opts.scheduledFrom) query.set("scheduledFrom", opts.scheduledFrom);
      if (opts.scheduledTo) query.set("scheduledTo", opts.scheduledTo);
      query.set("limit", opts.limit);

      if (!opts.all) {
        if (opts.cursor) query.set("cursor", opts.cursor);
        const res = await api.get<{ nextCursor: string | null }>(`/v1/posts?${query.toString()}`);
        emit(res);
        if (res.nextCursor) hint(`faden posts list --cursor ${res.nextCursor}`, "faden posts list --all");
        return;
      }

      // --all exists so agents stop hand-rolling cursor loops (and stop dropping the last page).
      const posts: unknown[] = [];
      let cursor = opts.cursor;
      do {
        if (cursor) query.set("cursor", cursor);
        const page = await api.get<{ posts: unknown[]; nextCursor: string | null }>(`/v1/posts?${query.toString()}`);
        posts.push(...page.posts);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      emit({ posts, nextCursor: null });
    },
  );

postsCmd
  .command("edit <postId>")
  .description("Edit a draft or scheduled post (fields left out keep their value)")
  .option("-c, --content <text>", 'new post text, or "-" for stdin and "@file.txt" for a file')
  .option("-p, --platforms <list>", "comma-separated platforms", parsePlatforms)
  .option("--accounts <refs>", "comma-separated account ids or handles: rebuild targets to these accounts", parseCommaList)
  .option("-m, --media <urls>", "comma-separated public media URLs", (v) => v.split(",").map((s) => s.trim()).filter(Boolean))
  .option("--at <when>", 'new schedule time, e.g. "2026-07-01T09:00 America/New_York" or ISO 8601')
  .option("--caption <platform=text>", "per-platform caption override (repeatable)", collectCaption, {})
  .option("--config <json>", 'platformConfigurations/accountConfigurations as JSON, or "@file.json" or "-"')
  .addHelpText(
    "after",
    `
Examples:
  faden posts edit pst_abc123 -c "Corrected copy"
  faden posts edit pst_abc123 --at "2026-07-02T18:00 Europe/Berlin"
  faden posts edit pst_abc123 --caption linkedin="Longer version for LinkedIn"`,
  )
  .action(
    async (
      postId: string,
      raw: {
        content?: string;
        platforms?: Platform[];
        accounts?: string[];
        media?: string[];
        at?: string;
        caption: Record<string, string>;
        config?: string;
      },
    ) => {
      const resolved = await resolveContentOptions(raw);
      const api = await client();
      const body: Record<string, unknown> = {};
      if (resolved.content !== undefined) body.content = resolved.content;
      if (raw.platforms) body.platforms = raw.platforms;
      if (raw.accounts) body.accountIds = raw.accounts;
      if (raw.media) body.mediaUrls = raw.media;
      if (raw.at) {
        const { scheduledFor, timezone } = toIsoUtc(raw.at);
        body.scheduledFor = scheduledFor;
        if (timezone) body.timezone = timezone;
      }
      applyConfigOptions(body, { caption: raw.caption, config: resolved.config });
      if (Object.keys(body).length === 0) {
        throw new CliError(
          "nothing to edit. Pass at least one of -c/-p/--accounts/-m/--at/--caption/--config",
          EXIT.validation,
        );
      }
      emit(await api.patch(`/v1/posts/${postId}`, body));
      hint(`faden posts get ${postId}`);
    },
  );

function makeApproveCommand(name: string, aliasNote = ""): Command {
  return new Command(name)
    .argument("<postId>")
    .description(`Approve a draft post: publish now, or schedule it with --at${aliasNote}`)
    .option("--at <when>", 'publish time, e.g. "2026-07-01T09:00 America/New_York" or ISO 8601')
    .option("--dry-run", "show what would be approved without approving", false)
    .addHelpText(
      "after",
      `
Examples:
  faden posts approve pst_abc123
  faden posts approve pst_abc123 --at "2026-07-01T09:00 America/New_York"
  faden posts approve pst_abc123 --dry-run`,
    )
    .action(async (postId: string, opts: { at?: string; dryRun: boolean }) => {
      const body: Record<string, unknown> = {};
      if (opts.at) body.scheduledFor = toIsoUtc(opts.at).scheduledFor;
      const api = await client();
      if (opts.dryRun) {
        const post = await api.get<{ status: string }>(`/v1/posts/${postId}`);
        emit({
          dryRun: true,
          postId,
          currentStatus: post.status,
          wouldApprove: post.status === "draft",
          request: { method: "POST", path: `/v1/posts/${postId}/approve`, body },
        });
        return;
      }
      emit(await api.post(`/v1/posts/${postId}/approve`, body));
      hint(`faden posts get ${postId}`);
    });
}

postsCmd.addCommand(makeApproveCommand("approve"));
program.addCommand(makeApproveCommand("approve", " (alias for `faden posts approve`)"));

postsCmd
  .command("cancel <postId>")
  .description("Cancel a scheduled or draft post (not one already publishing or finished)")
  .option("--dry-run", "show what would be cancelled without cancelling", false)
  .addHelpText(
    "after",
    `
Examples:
  faden posts cancel pst_abc123
  faden posts cancel pst_abc123 --dry-run
  faden posts list --status scheduled | jq -r '.posts[].id'   pick one to cancel`,
  )
  .action(async (postId: string, opts: { dryRun: boolean }) => {
    const api = await client();
    if (opts.dryRun) {
      const post = await api.get<{ status: string }>(`/v1/posts/${postId}`);
      emit({
        dryRun: true,
        postId,
        currentStatus: post.status,
        wouldCancel: post.status === "draft" || post.status === "scheduled",
        request: { method: "DELETE", path: `/v1/posts/${postId}` },
      });
      return;
    }
    emit(await api.delete(`/v1/posts/${postId}`));
    hint("faden posts list --status scheduled");
  });

interface AnalyticsTeaser {
  snapshotCount: number;
  since: string | null;
  until: string | null;
}

/** A 402 `plan_required` error body, or null for any other failure. */
function planRequired(err: unknown): { requiredPlan: string | null; teaser: AnalyticsTeaser } | null {
  if (err instanceof ApiError && err.status === 402 && err.body.error === "plan_required") {
    return {
      requiredPlan: (err.body.requiredPlan as string | null) ?? null,
      teaser: err.body.teaser as AnalyticsTeaser,
    };
  }
  return null;
}

interface AnalyticsResponse {
  postId: string;
  targets: Array<{
    platform: string;
    status: string;
    latest: { capturedAt: string; metrics: Record<string, number | null> } | null;
  }>;
}

function formatAnalytics(res: AnalyticsResponse): string {
  const metricColumns = ["impressions", "likes", "comments", "shares", "videoViews"];
  const header = ["platform", ...metricColumns, "capturedAt"];
  const rows = res.targets.map((t) => [
    t.platform,
    ...metricColumns.map((m) => String(t.latest?.metrics[m] ?? "-")),
    t.latest?.capturedAt ?? `no snapshot yet (target ${t.status})`,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  return [header, ...rows].map((line) => line.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}

function makeAnalyticsCommand(name: string, aliasNote = ""): Command {
  return new Command(name)
    .argument("<postId>")
    .description(`Per-platform metrics for a post (latest snapshot per target, where - means not exposed)${aliasNote}`)
    .option("--json", "force JSON output (same as --output json)")
    .addHelpText(
      "after",
      `
Examples:
  faden posts analytics pst_abc123
  faden posts analytics pst_abc123 --output json | jq '.targets[].latest.metrics'

Analytics is a paid feature. On a free plan this exits 5 with an upgrade hint.`,
    )
    .action(async (postId: string, opts: { json?: boolean }) => {
      const api = await client();
      let res: AnalyticsResponse;
      try {
        res = await api.get<AnalyticsResponse>(`/v1/posts/${postId}/analytics`);
      } catch (err) {
        // Analytics is a paid feature (#87): translate the 402 teaser into a plain upgrade hint.
        const gated = planRequired(err);
        if (!gated) throw err;
        const { requiredPlan, teaser } = gated;
        const collected =
          teaser.snapshotCount > 0
            ? `${teaser.snapshotCount} snapshot(s) collected${teaser.since ? ` since ${teaser.since.slice(0, 10)}` : ""}`
            : "no snapshots collected yet";
        throw new CliError(
          `Analytics is not on your plan. Upgrade to ${requiredPlan ?? "a paid plan"} to see it (${collected}).`,
          EXIT.rateLimited,
        );
      }
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      emit(res, formatAnalytics as (d: never) => string);
    });
}

postsCmd.addCommand(makeAnalyticsCommand("analytics"));
program.addCommand(makeAnalyticsCommand("analytics", " (alias for `faden posts analytics`)"));

// ---------------------------------------------------------------------------
// media
// ---------------------------------------------------------------------------

const media = program.command("media").description("Upload media for posts");

media
  .command("upload <file>")
  .description("Upload a local file and print the publicUrl to pass to --media")
  .option("--mime-type <type>", "override the extension-based MIME type guess")
  .addHelpText(
    "after",
    `
Examples:
  faden media upload ./shot.png
  faden posts create -p x -c "look" -m "$(faden media upload ./shot.png --output json | jq -r .publicUrl)"`,
  )
  .action(async (file: string, opts: { mimeType?: string }) => {
    const api = await client();
    const uploaded = await uploadMedia(api, file, opts.mimeType);
    emit(uploaded, (d: { publicUrl: string }) => d.publicUrl);
    hint(`faden posts create -p x -c "…" -m ${uploaded.publicUrl}`);
  });

// ---------------------------------------------------------------------------
// platforms / validate — offline, no API call, no credentials
// ---------------------------------------------------------------------------

const platformsCmd = program.command("platforms").description("Per-platform limits (offline, no API call)");

platformsCmd
  .command("list")
  .description("Character limits, media counts and accepted types for every platform")
  .option("-p, --platform <platform>", "only this platform")
  .addHelpText(
    "after",
    `
Examples:
  faden platforms list                    size content before posting, not after a 422
  faden platforms list -p x
  faden platforms list --output json | jq '.[] | {platform, maxContentLength}'`,
  )
  .action((opts: { platform?: string }) => {
    if (opts.platform && !isPlatform(opts.platform)) {
      throw new CliError(`unknown platform: ${opts.platform}. Valid: ${PLATFORMS.join(", ")}`, EXIT.validation);
    }
    const wanted = opts.platform ? [opts.platform as Platform] : [...PLATFORMS];
    const rows = wanted.map((platform) => ({ platform, ...PLATFORM_CONSTRAINTS[platform] }));
    emit(rows, (d: typeof rows) => {
      const header = ["platform", "maxChars", "maxMedia", "images", "video", "mediaRequired"];
      const body = d.map((r) => [
        r.platform,
        String(r.maxContentLength),
        String(r.maxMediaCount),
        r.allowsImages ? "yes" : "no",
        r.allowsVideo ? "yes" : "no",
        r.requiresMedia ? "yes" : "no",
      ]);
      const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
      return [header, ...body].map((line) => line.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
    });
  });

program
  .command("validate")
  .description("Check content against each platform's limits offline, with no API call and no credentials")
  .requiredOption("-p, --platforms <list>", "comma-separated platforms", parsePlatforms)
  .option("-c, --content <text>", 'post text, or "-" for stdin and "@file.txt" for a file', "")
  .option("-m, --media <urls>", "comma-separated public media URLs", (v) => v.split(",").map((s) => s.trim()).filter(Boolean))
  .option("--board <boardId>", "Pinterest destination board")
  .option("--location <locationId>", "Google Business destination location")
  .addHelpText(
    "after",
    `
Examples:
  faden validate -p x,linkedin -c "Draft copy"
  cat draft.md | faden validate -p x -c -
  faden validate -p pinterest -c "Pin" -m https://cdn.example/a.jpg --board b_1

Exits 3 when any platform rejects the content, so it can gate a pipeline.`,
  )
  .action(
    async (opts: { platforms: Platform[]; content: string; media?: string[]; board?: string; location?: string }) => {
      const content = isIndirect(opts.content) ? await resolveInput(opts.content) : opts.content;
      const platformCfg: Partial<Record<Platform, PublishOptions>> = {};
      if (opts.board) platformCfg.pinterest = { boardId: opts.board };
      if (opts.location) platformCfg.google_business = { locationId: opts.location };
      const result = preflight(opts.platforms, content, opts.media ?? [], platformCfg);
      emit(result, formatPreflight as (d: never) => string);
      if (!result.ok) process.exitCode = EXIT.validation;
      else hint(`faden posts create -p ${opts.platforms.join(",")} -c "…"`);
    },
  );

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

const keys = program.command("keys").description("Manage workspace API keys");

keys
  .command("list")
  .description("List keys (prefix and last use only, never the secrets)")
  .addHelpText("after", "\nExamples:\n  faden keys list\n  faden keys list --output json | jq -r '.[].id'")
  .action(async () => {
    const api = await client();
    const res = await api.get<{ keys: unknown[] }>("/v1/keys");
    emit(res.keys);
  });

keys
  .command("create <name>")
  .description("Mint a named key. The secret is printed once, so store it now")
  .addHelpText(
    "after",
    `
Examples:
  faden keys create ci-runner
  export FADEN_API_KEY=$(faden keys create ci-runner --output json | jq -r .key)`,
  )
  .action(async (name: string) => {
    const api = await client();
    emit(await api.post("/v1/keys", { name }));
    hint("faden keys list");
  });

keys
  .command("revoke <keyId>")
  .description("Revoke a key (the last active key is protected, so create a replacement first)")
  .option("--dry-run", "show which key would be revoked without revoking it", false)
  .option("-y, --yes", "revoke without the interactive confirmation", false)
  .addHelpText(
    "after",
    `
Examples:
  faden keys revoke key_123 --dry-run
  faden keys revoke key_123 --yes      required when stdout is a terminal`,
  )
  .action(async (keyId: string, opts: { dryRun: boolean; yes: boolean }) => {
    const api = await client();
    if (opts.dryRun) {
      const res = await api.get<{ keys: Array<{ id: string }> }>("/v1/keys");
      const target = res.keys.find((k) => k.id === keyId);
      emit({
        dryRun: true,
        keyId,
        found: Boolean(target),
        key: target ?? null,
        request: { method: "DELETE", path: `/v1/keys/${keyId}` },
      });
      if (!target) process.exitCode = EXIT.notFound;
      return;
    }
    // Non-interactive callers are never blocked: the guard only fires for a human at a terminal,
    // where an unintended revoke would otherwise be silent and irreversible.
    if (!opts.yes && process.stdout.isTTY) {
      throw new CliError(
        `revoking a key is irreversible. Re-run with --yes to confirm:\n  faden keys revoke ${keyId} --yes`,
        EXIT.validation,
      );
    }
    emit(await api.delete(`/v1/keys/${keyId}`));
    hint("faden keys list");
  });

// ---------------------------------------------------------------------------
// webhooks
// ---------------------------------------------------------------------------

/** Parse `--events a,b` into the validated list, or undefined for "every event". */
function parseEvents(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const events = value.split(",").map((e) => e.trim()).filter(Boolean);
  const unknown = events.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (unknown.length > 0) {
    throw new CliError(
      `unknown event(s): ${unknown.join(", ")}. Valid: ${WEBHOOK_EVENTS.join(", ")}`,
      EXIT.validation,
    );
  }
  return events.length > 0 ? events : undefined;
}

const webhooks = program
  .command("webhooks")
  .description("Manage endpoints that receive signed publish events");

webhooks
  .command("list")
  .description("List endpoints (signing secrets are never shown)")
  .addHelpText("after", "\nExamples:\n  faden webhooks list\n  faden webhooks list --output json | jq -r '.[].url'")
  .action(async () => {
    const api = await client();
    const res = await api.get<{ webhooks: unknown[] }>("/v1/webhooks");
    emit(res.webhooks);
  });

webhooks
  .command("add <url>")
  .description("Register an endpoint. The signing secret is printed once, so store it now")
  .option("-e, --events <list>", `comma-separated subset of: ${WEBHOOK_EVENTS.join(", ")} (default: all)`)
  .addHelpText(
    "after",
    `
Examples:
  faden webhooks add https://app.example/hooks/faden
  faden webhooks add https://app.example/hooks -e post.completed,post.failed
  faden webhooks add https://app.example/hooks --output json | jq -r .secret`,
  )
  .action(async (url: string, opts: { events?: string }) => {
    const api = await client();
    const events = parseEvents(opts.events);
    emit(await api.post("/v1/webhooks", { url, ...(events ? { events } : {}) }));
    hint("faden webhooks test <id>");
  });

webhooks
  .command("update <webhookId>")
  .description("Change an endpoint's URL, event filter or status (the signing secret is kept)")
  .option("-u, --url <url>", "new delivery URL")
  .option("-e, --events <list>", "new event filter, or 'all' to receive everything")
  .option("--status <status>", "'disabled' to pause deliveries, 'active' to resume")
  .addHelpText(
    "after",
    `
Examples:
  faden webhooks update wh_123 -e post.completed
  faden webhooks update wh_123 -e all           subscribe to every event
  faden webhooks update wh_123 -u https://new.example/hooks
  faden webhooks update wh_123 --status active  re-enable after fixing the receiver

faden disables an endpoint by itself once ${WEBHOOK_FAILURE_THRESHOLD} events in a row have exhausted their retries.
Re-activating resets that count, so fix the receiver (\`faden webhooks test\` confirms it) before
turning it back on.`,
  )
  .action(async (webhookId: string, opts: { url?: string; events?: string; status?: string }) => {
    if (opts.url === undefined && opts.events === undefined && opts.status === undefined) {
      throw new CliError("nothing to change. Pass --url, --events or --status", EXIT.validation);
    }
    if (opts.status !== undefined && !["active", "disabled"].includes(opts.status)) {
      throw new CliError(`unknown status: ${opts.status}. Valid: active, disabled`, EXIT.validation);
    }
    const api = await client();
    const body: Record<string, unknown> = {};
    if (opts.url !== undefined) body.url = opts.url;
    // `null` is the only way to say "every event"; an empty list is rejected by the API.
    if (opts.events !== undefined) body.events = opts.events === "all" ? null : parseEvents(opts.events);
    if (opts.status !== undefined) body.status = opts.status;
    emit(await api.patch(`/v1/webhooks/${webhookId}`, body));
  });

webhooks
  .command("deliveries <webhookId>")
  .description("What happened to this endpoint's events, newest first")
  .option("--status <status>", "only pending, delivered or failed")
  .option("--limit <n>", "page size (max 100)", "20")
  .option("--cursor <cursor>", "pagination cursor from the previous page")
  .option("--all", "follow the cursor and return every record", false)
  .addHelpText(
    "after",
    `
Examples:
  faden webhooks deliveries wh_123
  faden webhooks deliveries wh_123 --status failed --all
  faden webhooks deliveries wh_123 --output json | jq '[.deliveries[] | select(.attempts > 1)]'

A record is 'pending' while retries remain and 'failed' once the event has exhausted them, so a
'failed' row is an event your receiver never acknowledged. Records are kept for ${WEBHOOK_DELIVERY_RETENTION_DAYS} days.`,
  )
  .action(async (webhookId: string, opts: { status?: string; limit: string; cursor?: string; all: boolean }) => {
    if (opts.status !== undefined && !(WEBHOOK_DELIVERY_STATUSES as readonly string[]).includes(opts.status)) {
      throw new CliError(`unknown status: ${opts.status}. Valid: ${WEBHOOK_DELIVERY_STATUSES.join(", ")}`, EXIT.validation);
    }
    const api = await client();
    const path = `/v1/webhooks/${webhookId}/deliveries`;
    const query = new URLSearchParams();
    if (opts.status) query.set("status", opts.status);
    query.set("limit", opts.limit);

    if (!opts.all) {
      if (opts.cursor) query.set("cursor", opts.cursor);
      const res = await api.get<{ nextCursor: string | null }>(`${path}?${query.toString()}`);
      emit(res);
      if (res.nextCursor) hint(`faden webhooks deliveries ${webhookId} --cursor ${res.nextCursor}`);
      return;
    }

    const deliveries: unknown[] = [];
    let cursor = opts.cursor;
    do {
      if (cursor) query.set("cursor", cursor);
      const page = await api.get<{ deliveries: unknown[]; nextCursor: string | null }>(`${path}?${query.toString()}`);
      deliveries.push(...page.deliveries);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    emit({ deliveries, nextCursor: null });
  });

webhooks
  .command("test <webhookId>")
  .description("Send a synthetic post.completed and report what the receiver answered")
  .addHelpText(
    "after",
    `
Examples:
  faden webhooks test wh_123
  faden webhooks test wh_123 && echo "receiver is ready"

The event is signed with the endpoint's real secret and uses a type the endpoint subscribes to,
so a receiver that verifies the test verifies production deliveries. Its payload carries
"test": true and a placeholder postId. A receiver that does not answer 2xx exits 1: this is a
check, so it fails like one rather than reporting a negative result as success.`,
  )
  .action(async (webhookId: string) => {
    const api = await client();
    const result = await api.post<{ ok: boolean; status: number | null; durationMs: number; error?: string }>(
      `/v1/webhooks/${webhookId}/test`,
    );
    emit(result, (d: { ok: boolean; status: number | null; durationMs: number; error?: string }) =>
      d.ok
        ? `delivered: ${d.status} in ${d.durationMs}ms`
        : `not delivered: ${d.status ?? d.error ?? "no response"}${d.status ? ` in ${d.durationMs}ms` : ""}`,
    );
    // Non-zero on a receiver that refused, so the command can gate a deploy without parsing
    // stdout. Deliberately `generic` and not `rateLimited`: the documented meaning of 5 is
    // "retry later or upgrade", which would be a lie about a receiver returning 500.
    if (!result.ok) process.exitCode = EXIT.generic;
  });

webhooks
  .command("rm <webhookId>")
  .description("Delete an endpoint. Deliveries stop immediately")
  .option("--dry-run", "show which endpoint would be deleted without deleting it", false)
  .addHelpText(
    "after",
    `
Examples:
  faden webhooks rm wh_123 --dry-run
  faden webhooks rm wh_123`,
  )
  .action(async (webhookId: string, opts: { dryRun: boolean }) => {
    const api = await client();
    if (opts.dryRun) {
      const res = await api.get<{ webhooks: Array<{ id: string }> }>("/v1/webhooks");
      const target = res.webhooks.find((w) => w.id === webhookId);
      emit({
        dryRun: true,
        webhookId,
        found: Boolean(target),
        webhook: target ?? null,
        request: { method: "DELETE", path: `/v1/webhooks/${webhookId}` },
      });
      if (!target) process.exitCode = EXIT.notFound;
      return;
    }
    emit(await api.delete(`/v1/webhooks/${webhookId}`));
    hint("faden webhooks list");
  });

// ---------------------------------------------------------------------------
// queue
// ---------------------------------------------------------------------------

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Parse a repeatable "--slot mon@09:00" into { weekday, time }. */
function collectSlot(value: string, slots: { weekday: number; time: string }[]) {
  const [day, time] = value.split("@");
  const weekday = WEEKDAYS.indexOf((day ?? "").toLowerCase());
  if (weekday === -1 || !time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new CliError(`invalid slot "${value}". Expected <day>@<HH:MM>, e.g. mon@09:00`, EXIT.validation);
  }
  slots.push({ weekday, time });
  return slots;
}

const queueCmd = program.command("queue").description("Recurring posting-queue slots (post --queue fills them)");

queueCmd
  .command("list")
  .description("Show the queue slots and the next free slot")
  .addHelpText("after", "\nExamples:\n  faden queue list\n  faden posts create -p x -c \"…\" --queue")
  .action(async () => {
    const api = await client();
    emit(await api.get("/v1/queue"));
    hint("faden queue set -z Europe/Berlin -s mon@09:00");
  });

queueCmd
  .command("set")
  .description("Replace ALL queue slots with the ones given")
  .requiredOption("-z, --timezone <tz>", "IANA timezone the slot times are in")
  .requiredOption("-s, --slot <day@HH:MM>", "recurring weekly slot (repeatable)", collectSlot, [])
  .option("--dry-run", "print the replacement without applying it", false)
  .addHelpText(
    "after",
    `
Examples:
  faden queue set -z Europe/Berlin -s mon@09:00 -s thu@17:30
  faden queue set -z UTC -s mon@09:00 --dry-run

This REPLACES every existing slot, so run faden queue list first, or --dry-run.`,
  )
  .action(async (opts: { timezone: string; slot: { weekday: number; time: string }[]; dryRun: boolean }) => {
    const body = { timezone: opts.timezone, slots: opts.slot };
    const api = await client();
    if (opts.dryRun) {
      const current = await api.get<{ slots: unknown[] }>("/v1/queue");
      emit({ dryRun: true, currentSlots: current.slots, replacementSlots: opts.slot, request: { method: "PUT", path: "/v1/queue", body } });
      return;
    }
    emit(await api.put("/v1/queue", body));
    hint("faden queue list");
  });

// ---------------------------------------------------------------------------
// usage / bulk / mcp
// ---------------------------------------------------------------------------

program
  .command("usage")
  .description("Workspace consumption against the plan's quotas")
  .addHelpText("after", "\nExamples:\n  faden usage\n  faden usage --output json | jq .posts")
  .action(async () => {
    const api = await client();
    emit(await api.get("/v1/usage"));
  });

const bulk = program.command("bulk").description("Bulk operations");

bulk
  .command("import <file>")
  .description('Import a CSV of posts (validated as a batch, so any bad row rejects all). "-" reads stdin')
  .option("--dry-run", "print the parsed CSV without creating anything", false)
  .addHelpText(
    "after",
    `
Examples:
  faden bulk import posts.csv
  cat posts.csv | faden bulk import -
  faden bulk import posts.csv --dry-run

Any invalid row rejects the whole batch, so an import is all-or-nothing and safe to retry.`,
  )
  .action(async (file: string, opts: { dryRun: boolean }) => {
    const csv = await resolveInput(file === "-" ? "-" : `@${file}`);
    if (opts.dryRun) {
      const rows = csv.split("\n").filter((line) => line.trim().length > 0);
      emit({
        dryRun: true,
        rowCount: Math.max(rows.length - 1, 0),
        header: rows[0] ?? null,
        request: { method: "POST", path: "/v1/posts/bulk", contentType: "text/csv" },
      });
      return;
    }
    const api = await client();
    emit(await api.postRaw("/v1/posts/bulk", csv, { contentType: "text/csv" }));
    hint("faden posts list");
  });

program
  .command("mcp")
  .description("Run the faden MCP server on stdio (register in an MCP client with FADEN_API_KEY set)")
  .addHelpText(
    "after",
    `
Examples:
  faden mcp                       speaks MCP on stdio; not meant to be run by hand

Register it with an MCP client, e.g.:
  { "mcpServers": { "faden": { "command": "faden", "args": ["mcp"],
      "env": { "FADEN_API_KEY": "fdn_live_…" } } } }`,
  )
  .action(async () => {
    const { runMcpServer } = await import("./mcp.js");
    await runMcpServer(await client());
    // The transport owns the process from here; resolve keeps commander from exiting early.
    await new Promise(() => {});
  });

// ---------------------------------------------------------------------------

program.parseAsync(process.argv).catch((err: unknown) => {
  const exitCode = err instanceof CliError || err instanceof ApiError ? err.exitCode : EXIT.generic;
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  if (exitCode === EXIT.auth && !(err instanceof CliError)) {
    console.error("Check your key: `faden whoami`, `faden login`, or set FADEN_API_KEY.");
  }
  process.exitCode = exitCode;
});
