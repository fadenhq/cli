# Changelog

Notable changes to `@fadenhq/cli` — the `faden` command and the MCP server it ships
(`faden mcp`). Dates are npm publish dates.

Entries lead with anything that changes an observable contract: exit codes, the shape of
what lands on stdout, command names, and MCP tool schemas. Those are what a script or an
agent built against an older version can trip over. The MCP surface is self-describing at
runtime — a client re-reads the tool list on connect — so it is recorded here for humans
reading back, not because a client needs it to stay current.

## [Unreleased]

Entries land here as they merge and get a version heading at release, so nothing reaches npm
unrecorded.

## [0.4.1] - 2026-08-02

### Changed

- Help text, error messages and the posting skill reworded. Commands, flags, exit codes and the
  shape of what lands on stdout are unchanged.
- Media validation moved into `@fadenhq/shared`, which the CLI already bundles. No change to
  `faden media upload` or the `upload_media` tool.

## [0.4.0] - 2026-07-27

Webhook management from the CLI: register endpoints, check a receiver, and see what happened to
each event.

### Added

- **`faden webhooks`**: `list`, `add`, `update`, `deliveries`, `test`, `rm`. `test` sends a
  synthetic event to an endpoint and reports what the receiver answered, exiting non-zero unless it
  was 2xx — so `faden webhooks test <id>` can gate a deploy. `update` changes the URL or the event
  filter without rotating the signing secret (`-e all` subscribes to everything). Needs the API
  deployed 2026-07-26 or later.
- **`faden webhooks deliveries <id>`**: what happened to each event — attempt count, the
  receiver's status or the network error, latency. `--status failed` narrows it to events that
  never landed, `--all` follows the cursor. Records are kept 30 days. Needs the API deployed
  2026-07-27 or later.
- **`faden webhooks update --status active|disabled`** pauses an endpoint or re-enables one faden
  disabled. faden now switches an endpoint off after 5 events in a row exhaust their retries;
  re-enabling clears that count. `list` gains `consecutiveFailures` and `disabledAt`.

## [0.3.1] - 2026-07-26

### Added

- `--scheduled-from` / `--scheduled-to` on `posts list`, filtering on when a post is due to
  go out rather than when it was created — "what ships in August?" is a `scheduledFor`
  window. Posts with no schedule are excluded. Needs the API deployed 2026-07-26 or later.

### Fixed

- **`faden whoami` works after `faden login`.** It asked the API for the logged-in *user*,
  which a workspace API key cannot identify, so every call failed with `401 session token
  required (API keys have no user identity)`. It now asks who the *key* is, against the new
  `GET /v1/whoami`, and prints the workspace and plan alongside the key. Needs the API
  deployed 2026-07-26 or later; against an older one the command says so rather than
  reporting a bare 404.
  JSON output gains `workspace`, `role` and `auth`; the previously documented
  `.workspace.id` field now exists.

## [0.3.0] - 2026-07-26

Reworked the CLI for non-interactive use by agents and scripts.

### Changed

- **Output is TTY-aware.** Text on a terminal, JSON when stdout is piped or redirected.
  `--output json|text` forces either. Previously most commands printed JSON
  unconditionally: piped consumers see no change, but a terminal now shows text.
- **Failures exit with a specific code** rather than always `1` — `2` authentication,
  `3` validation, `4` not found, `5` rate limited or over quota. `0` success, `1`
  unexpected. `faden --help` lists them.
- **Commands are grouped under `faden posts <verb>`.** `post`, `status`, `approve` and
  `analytics` continue to work as top-level aliases; nothing was removed.

### Added

- `--idempotency-key` on `posts create`: replaying a key returns the original post with
  `replayed: true` instead of publishing a second one. Pick a key that identifies the
  intent, so every retry of it carries the same one. Needs the API deployed 2026-07-26 or
  later; older deployments ignore the header and create a post per call.
- Commands `whoami`, `posts cancel`, `media upload`, `platforms list` and `validate`.
- `platforms list` and `validate` answer **offline** — no API call and no credentials, so
  they are free to run before every create.
- `--dry-run` on the six commands that write: `posts create`, `posts approve`,
  `posts cancel`, `keys revoke`, `queue set`, `bulk import`.
- `--yes` to skip the `keys revoke` confirmation, which now only prompts on a terminal and
  never blocks a piped invocation.
- `@path` and `-` (stdin) accepted anywhere a flag takes a value, so content need not be
  shell-escaped.
- `--timeout <ms>` and `FADEN_TIMEOUT_MS`; requests default to a 60s timeout instead of
  hanging indefinitely. `0` disables it.
- `posts list --all` to page through every result rather than one page.
- Suggested next commands printed to **stderr** after a successful command, keeping stdout
  clean for parsing. `--no-hints` or `FADEN_NO_HINTS` turns them off.
- `--help` gained worked examples, the environment variable list and the exit code table.
- MCP tools `get_usage`, `list_queue_slots`, `set_queue_slots`,
  `list_platform_constraints` and `validate_post`; `create_post` accepts `idempotencyKey`.
  The last two run locally with no API call.

### Fixed

- A non-JSON response — proxy HTML, or an API URL pointing at the dashboard — reports the
  status and an excerpt of the body and names `FADEN_API_URL`, instead of surfacing a JSON
  parse error.
- Network failures name the underlying cause (`ECONNREFUSED`, `ENOTFOUND`, an expired
  certificate) rather than a bare `fetch failed`.
- A `200` whose body is not JSON now fails loudly instead of returning an empty object.

## [0.2.0] - 2026-07-17

### Added

- `faden login` opens a browser and mints a workspace key via `app.faden.io/cli-auth`, so
  a key no longer has to be created in the dashboard and pasted in.

### Changed

- `login --key` became optional (it was required). Pass it to store a key directly without
  the browser flow — the path CI and headless environments should use.

## [0.1.1] - 2026-07-17

No user-facing changes: a development dependency bump, published to confirm the release
pipeline from the public repository.

## [0.1.0] - 2026-07-17

Initial public release of the `faden` CLI and the bundled MCP server, AGPL-3.0.
