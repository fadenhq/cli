# faden (CLI + MCP server)

The `faden` CLI is a thin client over the faden API, plus an MCP server (`faden mcp`) so agent
runtimes can publish without shelling out. Published on npm: `npx @fadenhq/cli`.

```sh
npx @fadenhq/cli --help                # from npm, no checkout needed
# in the monorepo:
npm run build -w @fadenhq/cli          # bundles dist/index.js (the `faden` bin) via tsup
npm run dev -w @fadenhq/cli -- <args>  # run from source
```

## Auth

Two ways, in precedence order:

1. **Env vars:** `FADEN_API_KEY` (required) and `FADEN_API_URL` (defaults to
   `https://api.faden.io`). The natural fit for MCP client configs and CI.
2. **Config file:** `faden login` writes `~/.config/faden/config.json`.

`faden login` with no flags opens a browser and mints a key for this machine. It needs an
interactive terminal, so in CI or an agent sandbox (`!process.stdout.isTTY` or `CI` set) it fails
immediately with the non-interactive alternatives rather than blocking on the browser. Use
`faden login --key fdn_live_…` or `FADEN_API_KEY` there.

`faden whoami` reports the active key (masked), where it came from, and the workspace it resolves
to, exiting 2 when unauthenticated.

## Usage

```sh
faden login                       # browser flow; --key fdn_live_xxx for CI
faden whoami
faden accounts connect x          # prints an OAuth URL to open
faden accounts connect bluesky --identifier you.bsky.social --app-password xxxx-xxxx-xxxx-xxxx
faden accounts list
faden accounts boards <accountId>   # destination picker: Pinterest boards / Google Business locations
faden posts create -p x,linkedin -c "Shipping today" --at "2026-07-01T09:00 America/New_York"
faden posts create -p x -c "now" -m https://cdn.example/a.jpg
faden media upload ./shot.png      # local file -> hosted public URL for -m
faden posts create -p pinterest -c "Pin it" -m https://cdn.example/a.jpg --board <boardId>
faden posts create -p google_business -c "Summer hours start Monday" --location <locationId>
faden posts create -p x,linkedin -c "draft for review" --draft
faden queue set -z Europe/Berlin -s mon@09:00 -s thu@17:30
faden posts create -p x -c "cadence post" --queue   # next free queue slot
faden queue list
faden posts approve <postId> --at "2026-07-01T09:00 Europe/Berlin"
faden posts get <postId>
faden posts cancel <postId>
faden posts analytics <postId>  # per-platform metrics table
faden posts list --status scheduled --all
faden usage                     # consumption vs plan quotas
faden bulk import posts.csv
faden keys create ci            # secret printed once
faden keys list
faden keys revoke <keyId> --yes # last active key is protected
```

`--at` accepts either a full ISO 8601 instant or `"<local-datetime> <IANA timezone>"`. The CLI
converts it to a UTC instant before sending.

Commands are resource-first (`faden posts create|get|list|edit|approve|cancel|analytics`). The
older top-level verbs (`faden post`, `faden status`, `faden approve`, `faden analytics`) still
work as aliases for the same commands.

## Designed for agents

The primary consumer is an agent, not a human at a keyboard, so:

- **Nothing prompts.** Every input is a flag, and the one interactive flow (`faden login`) fails fast
  with its non-interactive alternatives instead of blocking.
- **Every command's `--help` carries examples**, so a surface can be learned one subcommand at a
  time rather than from a wall of docs.
- **Flags, stdin or a file.** `-c -` reads stdin, `-c @notes.txt` reads a file, and `--config`
  and `bulk import` accept the same forms, so multi-line content needs no shell escaping.

  ```sh
  faden posts create -p x -c - < announcement.txt
  cat posts.csv | faden bulk import -
  faden posts create -p x -c "…" --config @overrides.json
  ```
- **Retries are safe.** `--idempotency-key <key>` is sent as an `Idempotency-Key` header, and replaying
  a key returns the original post (with `replayed: true`) instead of publishing a second time.
- **`--dry-run` before anything destructive:** `posts create`, `posts cancel`, `posts approve`,
  `bulk import`, `queue set`, `keys revoke`. For `posts create` it runs the full per-platform
  pre-flight locally, with zero API calls.
- **Offline discovery.** `faden platforms list` prints every platform's limits and `faden validate`
  checks content against them. Neither needs credentials or a network call, so content can be sized
  before posting rather than after a 422.
- **Machine-readable by default.** Output is JSON whenever stdout is not a terminal, and `--output
  json|text` forces either. Suggested next commands go to **stderr**, so stdout stays pipeable.
- **Distinct exit codes**: `2` auth, `3` validation, `4` not found, `5` rate limited/quota,
  `1` anything else. `faden --help` documents the table.
- **Bounded requests.** Every call carries a 60s timeout (`--timeout <ms>`, `FADEN_TIMEOUT_MS`,
  `0` to disable), and failures name the URL and the underlying cause rather than `fetch failed`.

| Env var | Effect |
| --- | --- |
| `FADEN_API_KEY` | Workspace key, skipping the config file entirely |
| `FADEN_API_URL` | API base URL (default `https://api.faden.io`) |
| `FADEN_TIMEOUT_MS` | Default per-request timeout in ms |
| `FADEN_NO_HINTS` | Set to any value to suppress next-command hints |

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

Tools:

- **Posting:** `create_post` (takes `idempotencyKey`, so a retry returns the original post rather
  than publishing twice), `get_post_status`, `list_posts`, `update_post`, `cancel_post`,
  `approve_post`, `post_analytics`
- **Accounts and media:** `list_accounts`, `connect_account` (returns an authUrl for the human to
  open), `upload_media` (local file → hosted public URL for `mediaUrls`)
- **Planning:** `get_usage`, `list_queue_slots`, `set_queue_slots`
- **Offline, no API call:** `list_platform_constraints` and `validate_post`, so content can be
  sized and checked before a `create_post` is attempted

Every tool has a CLI equivalent. The reverse is nearly true: `faden keys` is deliberately CLI-only
(minting credentials is a human decision, not an agent one), and `faden bulk import` has no tool
because looping `create_post` is the natural MCP idiom for what CSV solves at the shell.

## Posting skill

The MCP tools say what is callable. The skill (`plugin/skills/faden/SKILL.md`) says how to use
them well: check the constraints before writing, tailor the text per platform, and read the
per-target results rather than assuming a post either worked or didn't.

```sh
npx skills add fadenhq/cli        # this project; -g for every project
npx skills update                 # refresh the copy later
```

That copies the skill file into whichever agents you have, so it is not Claude Code-specific.
Being a copy, it is a snapshot of the skill at install time, and `skills update` re-fetches it and
compares against the hash in `skills-lock.json`. It installs the skill alone. To get the MCP
server as well, Claude Code can take the whole plugin instead:

```sh
/plugin marketplace add fadenhq/cli
/plugin install faden@faden
```

The skill's accuracy is enforced rather than trusted: `src/skill.test.ts` fails the build if it
names a CLI command or an MCP tool that does not exist, so renaming either one here breaks CI
instead of shipping wrong instructions to every install.

## Bulk CSV format

Header row, then one post per row. `platforms` and `mediaUrls` are `;`/`|`-separated.

```csv
content,platforms,mediaUrls,scheduledFor,timezone
"Hello world",x;linkedin,,2026-07-01T13:00:00Z,
"With image",x,https://cdn.example/a.jpg,,
```
