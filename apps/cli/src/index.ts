#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { CREDENTIAL_CONNECT_PLATFORMS, isPlatform, PLATFORMS, type Platform } from "@fadenhq/shared";
import { Command } from "commander";
import { ApiClient } from "./client.js";
import { loadConfig, saveConfig } from "./config.js";
import { toIsoUtc } from "./time.js";

const program = new Command();
program.name("faden").description("Unified social-media publishing CLI").version("0.0.0");

async function client(): Promise<ApiClient> {
  return new ApiClient(await loadConfig());
}

function parsePlatforms(value: string): Platform[] {
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((p) => !isPlatform(p));
  if (bad.length > 0) {
    throw new Error(`unknown platform(s): ${bad.join(", ")} — valid: ${PLATFORMS.join(", ")}`);
  }
  return list as Platform[];
}

program
  .command("login")
  .alias("setup")
  .description("Store the API URL and workspace key (or skip this and set FADEN_API_KEY)")
  .option("-u, --url <url>", "API base URL", "https://api.faden.io")
  .requiredOption("-k, --key <apiKey>", "workspace API key (fdn_live_…)")
  .action(async (opts: { url: string; key: string }) => {
    const path = await saveConfig({ apiUrl: opts.url.replace(/\/$/, ""), apiKey: opts.key });
    console.log(`Saved credentials to ${path}`);
  });

const accounts = program.command("accounts").description("Manage connected social accounts");

accounts
  .command("connect <platform>")
  .description("Connect a social account (OAuth URL to open; Bluesky connects with an app password)")
  .option("--return-to <url>", "redirect target after OAuth completes")
  .option("--identifier <identifier>", "account handle/email (credential platforms, e.g. bluesky)")
  .option("--app-password <password>", "app password from the platform's settings (credential platforms)")
  .action(async (platform: string, opts: { returnTo?: string; identifier?: string; appPassword?: string }) => {
    if (!isPlatform(platform)) throw new Error(`unknown platform: ${platform}`);
    const api = await client();

    if ((CREDENTIAL_CONNECT_PLATFORMS as readonly string[]).includes(platform)) {
      if (!opts.identifier || !opts.appPassword) {
        throw new Error(
          `${platform} connects with an app password, not OAuth:\n` +
            `  faden accounts connect ${platform} --identifier you.bsky.social --app-password xxxx-xxxx-xxxx-xxxx\n` +
            `Create one at bsky.app → Settings → Privacy and Security → App Passwords.`,
        );
      }
      const res = await api.post<{ accounts: string[] }>(`/v1/accounts/${platform}/connect`, {
        identifier: opts.identifier,
        appPassword: opts.appPassword,
      });
      console.log(`Connected: ${res.accounts.join(", ")}`);
      return;
    }

    const query = opts.returnTo ? `?returnTo=${encodeURIComponent(opts.returnTo)}` : "";
    const res = await api.post<{ authUrl: string }>(`/v1/accounts/${platform}/connect${query}`);
    console.log("Open this URL in your browser to authorize:\n");
    console.log(res.authUrl);
  });

accounts
  .command("list")
  .description("List connected accounts")
  .action(async () => {
    const api = await client();
    const res = await api.get<{ accounts: unknown[] }>("/v1/accounts");
    console.log(JSON.stringify(res.accounts, null, 2));
  });

accounts
  .command("boards <accountId>")
  .description("List an account's publish destinations (Pinterest boards via --board, Google Business locations via --location)")
  .action(async (accountId: string) => {
    const api = await client();
    const res = await api.get<{ boards: unknown[] }>(`/v1/accounts/${accountId}/boards`);
    console.log(JSON.stringify(res.boards, null, 2));
  });

/** Repeatable `--caption platform=text` collector. */
function collectCaption(value: string, prev: Record<string, string>): Record<string, string> {
  const eq = value.indexOf("=");
  const platform = eq === -1 ? "" : value.slice(0, eq).trim();
  if (!isPlatform(platform)) throw new Error(`--caption expects <platform>=<text> with a valid platform, got: ${value}`);
  return { ...prev, [platform]: value.slice(eq + 1) };
}

/** `--config` escape hatch: raw JSON with platformConfigurations / accountConfigurations. */
function parseConfigJson(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("--config must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--config must be a JSON object like {\"platformConfigurations\": {...}}");
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

program
  .command("post")
  .description("Publish or schedule a post across platforms")
  .requiredOption("-p, --platforms <list>", "comma-separated platforms", parsePlatforms)
  .option("-c, --content <text>", "post text", "")
  .option("-m, --media <urls>", "comma-separated public media URLs", (v) => v.split(",").map((s) => s.trim()).filter(Boolean))
  .option("--at <when>", 'schedule time, e.g. "2026-07-01T09:00 America/New_York" or ISO 8601')
  .option("--queue", "schedule into the next free posting-queue slot (see: faden queue)", false)
  .option("--draft", "store as a draft (do not auto-publish)", false)
  .option("--caption <platform=text>", "per-platform caption override (repeatable)", collectCaption, {})
  .option("--board <boardId>", "Pinterest destination board (see: faden accounts boards <accountId>)")
  .option("--location <locationId>", "Google Business destination location (see: faden accounts boards <accountId>)")
  .option("--config <json>", "platformConfigurations/accountConfigurations as raw JSON", parseConfigJson)
  .action(
    async (opts: {
      platforms: Platform[];
      content: string;
      media?: string[];
      at?: string;
      queue: boolean;
      draft: boolean;
      caption: Record<string, string>;
      board?: string;
      location?: string;
      config?: Record<string, unknown>;
    }) => {
      const api = await client();
      const body: Record<string, unknown> = {
        content: opts.content,
        platforms: opts.platforms,
        mediaUrls: opts.media ?? [],
        draft: opts.draft,
      };
      if (opts.queue) body.useQueue = true;
      if (opts.at) {
        const { scheduledFor, timezone } = toIsoUtc(opts.at);
        body.scheduledFor = scheduledFor;
        if (timezone) body.timezone = timezone;
      }
      applyConfigOptions(body, opts);
      if (opts.board) {
        const platformCfg = { ...(body.platformConfigurations as Record<string, Record<string, unknown>> | undefined) };
        platformCfg.pinterest = { ...platformCfg.pinterest, boardId: opts.board };
        body.platformConfigurations = platformCfg;
      }
      if (opts.location) {
        const platformCfg = { ...(body.platformConfigurations as Record<string, Record<string, unknown>> | undefined) };
        platformCfg.google_business = { ...platformCfg.google_business, locationId: opts.location };
        body.platformConfigurations = platformCfg;
      }
      const res = await api.post("/v1/posts", body);
      console.log(JSON.stringify(res, null, 2));
    },
  );

const keys = program.command("keys").description("Manage workspace API keys");

keys
  .command("list")
  .description("List keys (prefix + last use only; secrets are never shown)")
  .action(async () => {
    const api = await client();
    const res = await api.get<{ keys: unknown[] }>("/v1/keys");
    console.log(JSON.stringify(res.keys, null, 2));
  });

keys
  .command("create <name>")
  .description("Mint a named key — the secret is printed once, store it now")
  .action(async (name: string) => {
    const api = await client();
    const res = await api.post("/v1/keys", { name });
    console.log(JSON.stringify(res, null, 2));
  });

keys
  .command("revoke <keyId>")
  .description("Revoke a key (the last active key is protected; create a replacement first)")
  .action(async (keyId: string) => {
    const api = await client();
    const res = await api.delete(`/v1/keys/${keyId}`);
    console.log(JSON.stringify(res, null, 2));
  });

program
  .command("approve <postId>")
  .description("Approve a draft post: publish now, or schedule it with --at")
  .option("--at <when>", 'publish time, e.g. "2026-07-01T09:00 America/New_York" or ISO 8601')
  .action(async (postId: string, opts: { at?: string }) => {
    const api = await client();
    const body: Record<string, unknown> = {};
    if (opts.at) body.scheduledFor = toIsoUtc(opts.at).scheduledFor;
    const res = await api.post(`/v1/posts/${postId}/approve`, body);
    console.log(JSON.stringify(res, null, 2));
  });

const postsCmd = program.command("posts").description("List and edit posts");

postsCmd
  .command("list")
  .description("List posts, newest first")
  .option("--status <status>", "filter: draft|scheduled|publishing|completed|partial|failed")
  .option("--platform <platform>", "filter by target platform")
  .option("--from <iso>", "createdAt lower bound (inclusive, ISO 8601)")
  .option("--to <iso>", "createdAt upper bound (exclusive, ISO 8601)")
  .option("--limit <n>", "page size (max 100)", "20")
  .option("--cursor <cursor>", "pagination cursor from the previous page")
  .action(async (opts: { status?: string; platform?: string; from?: string; to?: string; limit: string; cursor?: string }) => {
    const api = await client();
    const query = new URLSearchParams();
    if (opts.status) query.set("status", opts.status);
    if (opts.platform) query.set("platform", opts.platform);
    if (opts.from) query.set("from", opts.from);
    if (opts.to) query.set("to", opts.to);
    query.set("limit", opts.limit);
    if (opts.cursor) query.set("cursor", opts.cursor);
    const res = await api.get(`/v1/posts?${query.toString()}`);
    console.log(JSON.stringify(res, null, 2));
  });

postsCmd
  .command("edit <postId>")
  .description("Edit a draft or scheduled post (fields left out keep their value)")
  .option("-c, --content <text>", "new post text")
  .option("-p, --platforms <list>", "comma-separated platforms", parsePlatforms)
  .option("-m, --media <urls>", "comma-separated public media URLs", (v) => v.split(",").map((s) => s.trim()).filter(Boolean))
  .option("--at <when>", 'new schedule time, e.g. "2026-07-01T09:00 America/New_York" or ISO 8601')
  .option("--caption <platform=text>", "per-platform caption override (repeatable)", collectCaption, {})
  .option("--config <json>", "platformConfigurations/accountConfigurations as raw JSON", parseConfigJson)
  .action(
    async (
      postId: string,
      opts: {
        content?: string;
        platforms?: Platform[];
        media?: string[];
        at?: string;
        caption: Record<string, string>;
        config?: Record<string, unknown>;
      },
    ) => {
      const api = await client();
      const body: Record<string, unknown> = {};
      if (opts.content !== undefined) body.content = opts.content;
      if (opts.platforms) body.platforms = opts.platforms;
      if (opts.media) body.mediaUrls = opts.media;
      if (opts.at) {
        const { scheduledFor, timezone } = toIsoUtc(opts.at);
        body.scheduledFor = scheduledFor;
        if (timezone) body.timezone = timezone;
      }
      applyConfigOptions(body, opts);
      if (Object.keys(body).length === 0) {
        throw new Error("nothing to edit — pass at least one of -c/-p/-m/--at/--caption/--config");
      }
      const res = await api.patch(`/v1/posts/${postId}`, body);
      console.log(JSON.stringify(res, null, 2));
    },
  );

program
  .command("mcp")
  .description("Run the faden MCP server on stdio (register in an MCP client with FADEN_API_KEY set)")
  .action(async () => {
    const { runMcpServer } = await import("./mcp.js");
    await runMcpServer(await client());
    // The transport owns the process from here; resolve keeps commander from exiting early.
    await new Promise(() => {});
  });

program
  .command("status <postId>")
  .description("Show a post's status and per-platform results")
  .action(async (postId: string) => {
    const api = await client();
    const res = await api.get(`/v1/posts/${postId}`);
    console.log(JSON.stringify(res, null, 2));
  });

program
  .command("analytics <postId>")
  .description("Per-platform metrics for a post (latest snapshot per target; - = not exposed)")
  .option("--json", "print the full response including the time series as JSON")
  .action(async (postId: string, opts: { json?: boolean }) => {
    const api = await client();
    const res = await api.get<{
      postId: string;
      targets: Array<{
        platform: string;
        status: string;
        latest: { capturedAt: string; metrics: Record<string, number | null> } | null;
      }>;
    }>(`/v1/posts/${postId}/analytics`);
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    const metricColumns = ["impressions", "likes", "comments", "shares", "videoViews"];
    const header = ["platform", ...metricColumns, "capturedAt"];
    const rows = res.targets.map((t) => [
      t.platform,
      ...metricColumns.map((m) => String(t.latest?.metrics[m] ?? "-")),
      t.latest?.capturedAt ?? `no snapshot yet (target ${t.status})`,
    ]);
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
    for (const line of [header, ...rows]) {
      console.log(line.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd());
    }
  });

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Parse a repeatable "--slot mon@09:00" into { weekday, time }. */
function collectSlot(value: string, slots: { weekday: number; time: string }[]) {
  const [day, time] = value.split("@");
  const weekday = WEEKDAYS.indexOf((day ?? "").toLowerCase());
  if (weekday === -1 || !time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error(`invalid slot "${value}" — expected <day>@<HH:MM>, e.g. mon@09:00`);
  }
  slots.push({ weekday, time });
  return slots;
}

const queueCmd = program.command("queue").description("Recurring posting-queue slots (post --queue fills them)");

queueCmd
  .command("list")
  .description("Show the queue slots and the next free slot")
  .action(async () => {
    const api = await client();
    const res = await api.get("/v1/queue");
    console.log(JSON.stringify(res, null, 2));
  });

queueCmd
  .command("set")
  .description("Replace the queue slots, e.g. faden queue set -z Europe/Berlin -s mon@09:00 -s thu@17:30")
  .requiredOption("-z, --timezone <tz>", "IANA timezone the slot times are in")
  .requiredOption("-s, --slot <day@HH:MM>", "recurring weekly slot (repeatable)", collectSlot, [])
  .action(async (opts: { timezone: string; slot: { weekday: number; time: string }[] }) => {
    const api = await client();
    const res = await api.put("/v1/queue", { timezone: opts.timezone, slots: opts.slot });
    console.log(JSON.stringify(res, null, 2));
  });

program
  .command("usage")
  .description("Workspace consumption against the plan's quotas")
  .action(async () => {
    const api = await client();
    const res = await api.get("/v1/usage");
    console.log(JSON.stringify(res, null, 2));
  });

const bulk = program.command("bulk").description("Bulk operations");
bulk
  .command("import <file>")
  .description("Import a CSV of posts (validated as a batch; any bad row rejects all)")
  .action(async (file: string) => {
    const api = await client();
    const csv = await readFile(file, "utf8");
    const res = await api.postRaw("/v1/posts/bulk", csv);
    console.log(JSON.stringify(res, null, 2));
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
