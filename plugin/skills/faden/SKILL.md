---
name: faden
description: Publish, schedule, edit and track social-media posts across X, LinkedIn, Facebook, Instagram, Threads, Bluesky, TikTok, YouTube, Pinterest and Google Business through the faden API. Use when the user wants to post to social media, cross-post, schedule content, tailor a post per platform, check publish status, or upload media for a post.
---

# Publishing with faden

faden is a unified social-media fan-out API: one request publishes a post across every connected
platform, with per-target results and stable error codes.

## Prerequisites

- Auth: the `FADEN_API_KEY` env var (a workspace key, `fdn_live_…`), or `npx @fadenhq/cli login --key …`.
- Prefer the **faden MCP tools** (`create_post`, `get_post_status`, …) when they are available in
  this session. Otherwise use the CLI: `npx @fadenhq/cli <command>`.
- A platform must be connected before posting to it. Check with `list_accounts` /
  `npx @fadenhq/cli accounts list`, and connect with `connect_account` / `npx @fadenhq/cli accounts connect <platform>`.
  Both return an OAuth URL **the user must open in a browser**, and you cannot complete OAuth for them.
  After consent, faden shows a page naming the target workspace; the user clicks Continue there to finish.
  Exception: **bluesky** connects directly with credentials the user provides (no URL):
  `connect_account { "platform": "bluesky", "identifier": "you.bsky.social", "appPassword": "…" }`.
  The app password comes from bsky.app → Settings → Privacy and Security → App Passwords, never the main password.

## Check before you post

Two calls answer offline, with no API request and no credentials. Use them instead of learning a
limit from a rejected create:

```
list_platform_constraints { "platform": "x" }        # char ceiling, media count, accepted types
validate_post { "content": "…", "platforms": ["x", "linkedin"] }
# CLI: npx @fadenhq/cli platforms list -p x
#      npx @fadenhq/cli validate -p x,linkedin -c "…"   (exits 3 when anything fails)
```

`validate_post` runs the same per-platform checks the API runs, so it catches the common rejections
(`content_too_long`, `media_required`, `board_required`) before a post is attempted. It cannot see
what only the server knows, such as whether an account is connected or a remote file's real type
and size, so a clean result rules out the usual failures rather than guaranteeing success. The CLI
equivalent for a full create is `npx @fadenhq/cli posts create … --dry-run`, which also prints the
request body it would send.

## Core flows

**Immediate cross-post**

```
create_post { "content": "Ship day 🚀", "platforms": ["x", "linkedin"] }
# CLI: npx @fadenhq/cli posts create -p x,linkedin -c "Ship day 🚀"
```

**Always pass `idempotencyKey` when you might retry.** A create that times out or whose result you
lose is ambiguous: without a key, retrying publishes a *second* real post, which cannot be undone
once it is live. With one, the retry returns the original post and `replayed: true`:

```
create_post { "content": "Ship day", "platforms": ["x"], "idempotencyKey": "ship-2026-08-01" }
# CLI: npx @fadenhq/cli posts create -p x -c "Ship day" --idempotency-key ship-2026-08-01
```

Choose a key that identifies the *intent* (what the user asked for), not the attempt, so every
retry of that intent carries the same one.

**Schedule:** `scheduledFor` is ISO 8601 with offset. Pass `timezone` (IANA) when the user gave a local time:

```
create_post { "content": "…", "platforms": ["x"], "scheduledFor": "2026-08-01T09:00:00+02:00", "timezone": "Europe/Berlin" }
# CLI: npx @fadenhq/cli posts create -p x -c "…" --at "2026-08-01T09:00 Europe/Berlin"
```

**Queue cadence:** when the user wants regular posting without picking times, configure weekly
slots once (`set_queue_slots`, CLI: `npx @fadenhq/cli queue set -z Europe/Berlin -s mon@09:00`) and
create posts with `"useQueue": true` (CLI: `--queue`). Each drops into the next free slot.
`useQueue` is mutually exclusive with `scheduledFor` and `draft`. Read the current slots with
`list_queue_slots` first, because `set_queue_slots` REPLACES all of them. `get_usage` reports
consumption against the plan's quotas. Check it before a bulk run, since a post over quota is
rejected rather than queued.

**Tailor per platform:** `platformConfigurations` overrides content/media per platform
(X gets 280 chars, LinkedIn the long version). `accountConfigurations` (keyed by account id from
`list_accounts`) overrides per account and wins over platform overrides:

```
create_post {
  "content": "Long-form announcement …",
  "platforms": ["x", "linkedin", "instagram"],
  "mediaUrls": ["https://media.faden.io/…"],
  "platformConfigurations": {
    "x": { "content": "Short punchy version 🚀" },
    "instagram": { "placement": "reel", "coverImageUrl": "https://…" }
  }
}
# CLI: npx @fadenhq/cli posts create -p x,linkedin -c "Long version" --caption x="Short version"
```

**Media:** platforms fetch media by URL, so files must be publicly reachable. Upload local files
first with `upload_media { "filePath": "/abs/path.jpg" }` → returns the `publicUrl` to put in
`mediaUrls`. Instagram, TikTok, YouTube and Pinterest all require media. The Instagram feed accepts only JPEG
images, and Pinterest is image-only.

**Pinterest boards and Google Business locations:** these platforms publish into a destination
sub-resource. List destinations with `GET /v1/accounts/{accountId}/boards`
(CLI: `npx @fadenhq/cli accounts boards <accountId>`) and pass one as
`"platformConfigurations": { "pinterest": { "boardId": "…" } }` (CLI: `--board <id>`) or
`"platformConfigurations": { "google_business": { "locationId": "…" } }` (CLI: `--location <id>`).
Pre-flight rejects posts without one (`board_required` / `location_required`). Google Business
posts may add a CTA button: `ctaType` (BOOK/ORDER/SHOP/LEARN_MORE/SIGN_UP/CALL) + `linkUrl`.

**Status:** publishing is asynchronous. `create_post` returns a `postId`, and you check per-target
results with `get_post_status`. Each target reports `status` (pending/publishing/completed/failed),
the platform-native post id, and a stable `errorCode` on failure.

**Edit or cancel before publish:** drafts and scheduled posts only, `update_post` / `cancel_post`
(CLI: `npx @fadenhq/cli posts edit <id> …` / `npx @fadenhq/cli posts cancel <id>`). Once a post is `publishing` it can no longer be changed.

## Error handling

- `422 validation_failed` lists per-platform pre-flight issues (`content_too_long`,
  `account_not_connected`, `media_required`, …). Fix the offending platform with a
  `platformConfigurations` override or drop the platform, then retry.
- Target `errorCode` values are stable: `rate_limited` and `upstream_unavailable` retry
  automatically with backoff. `account_revoked` means the user must reconnect the account.
  `content_invalid` and `media_invalid` need a changed post.
- Draft-first is the safe default for human-in-the-loop workflows: create with `"draft": true`
  and show the user before anything publishes. Drafts never auto-publish. Once the user signs
  off, promote the draft with `approve_post { "postId": "…" }` (optionally with `scheduledFor`).
  CLI: `npx @fadenhq/cli posts approve <postId> [--at "…"]`. Edit first with `update_post` if the user
  wants changes.

## Analytics

`post_analytics { "postId": "…" }` (CLI: `npx @fadenhq/cli posts analytics <postId>`) returns the latest
snapshot plus a time series per platform target. Metrics are integers or `null`, where `null` means
the platform does not expose that metric. Never report it as 0. Snapshots start after a post
completes (hourly on day one, then daily), so a just-published post may have an empty series.
