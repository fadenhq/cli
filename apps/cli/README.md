# faden (CLI + MCP server)

The `faden` CLI — a thin client over the faden API — plus an MCP server (`faden mcp`) so agent
runtimes can publish without shelling out. Published on npm: `npx @fadenhq/cli`.

```sh
npx @fadenhq/cli --help                # from npm, no checkout needed
# in the monorepo:
npm run build -w @fadenhq/cli          # bundles dist/index.js (the `faden` bin) via tsup
npm run dev -w @fadenhq/cli -- <args>  # run from source
```

## Auth

Two ways, in precedence order:

1. **Env vars** — `FADEN_API_KEY` (required) and `FADEN_API_URL` (defaults to
   `https://api.faden.io`). The natural fit for MCP client configs and CI.
2. **Config file** — `faden login` writes `~/.config/faden/config.json`.

## Usage

```sh
faden login --url http://localhost:8787 --key fdn_live_xxx
faden accounts connect x          # prints an OAuth URL to open
faden accounts connect bluesky --identifier you.bsky.social --app-password xxxx-xxxx-xxxx-xxxx
faden accounts list
faden accounts boards <accountId>   # destination picker: Pinterest boards / Google Business locations
faden post -p x,linkedin -c "Shipping today 🚀" --at "2026-07-01T09:00 America/New_York"
faden post -p x -c "now" -m https://cdn.example/a.jpg
faden post -p pinterest -c "Pin it" -m https://cdn.example/a.jpg --board <boardId>
faden post -p google_business -c "Summer hours start Monday" --location <locationId>
faden post -p x,linkedin -c "draft for review" --draft
faden queue set -z Europe/Berlin -s mon@09:00 -s thu@17:30
faden post -p x -c "cadence post" --queue   # next free queue slot
faden queue list
faden approve <postId> --at "2026-07-01T09:00 Europe/Berlin"
faden status <postId>
faden analytics <postId>        # per-platform metrics table (--json for the time series)
faden usage                     # consumption vs plan quotas
faden bulk import posts.csv
faden keys create ci            # secret printed once
faden keys list
faden keys revoke <keyId>       # last active key is protected
```

`--at` accepts either a full ISO 8601 instant or `"<local-datetime> <IANA timezone>"`; the CLI
converts it to a UTC instant before sending.

## MCP server

`faden mcp` runs an MCP server on stdio wrapping the REST API 1:1. Tool input schemas are the
same Zod validators the API parses with, so agents get the strict contract (typed platform
enums, per-platform overrides, ISO 8601 timestamps) directly in the tool definitions.

Register it in an MCP client (Claude Code example):

```sh
claude mcp add faden --env FADEN_API_KEY=fdn_live_… -- npx @fadenhq/cli mcp
```

Or in a JSON MCP config:

```json
{
  "mcpServers": {
    "faden": {
      "command": "npx",
      "args": ["-y", "@fadenhq/cli", "mcp"],
      "env": { "FADEN_API_KEY": "fdn_live_…" }
    }
  }
}
```

Tools: `create_post`, `get_post_status`, `list_posts`, `update_post`, `cancel_post`,
`list_accounts`, `connect_account` (returns an authUrl for the human to open), and
`upload_media` (local file → hosted public URL for `mediaUrls`).

## Bulk CSV format

Header row, then one post per row. `platforms` and `mediaUrls` are `;`/`|`-separated.

```csv
content,platforms,mediaUrls,scheduledFor,timezone
"Hello world",x;linkedin,,2026-07-01T13:00:00Z,
"With image",x,https://cdn.example/a.jpg,,
```
