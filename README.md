# faden CLI + MCP server

The open-source client for [faden](https://faden.io) — a unified social-media publishing API.
One command (or one MCP tool call) posts across X, LinkedIn, Facebook, Instagram, Threads,
Bluesky and more; faden handles each network's OAuth, media and scheduling quirks.

```sh
npm install -g @fadenhq/cli     # installs the `faden` command
faden login --key fdn_live_…
faden post -p x,linkedin -c "Hello from faden 🚀"
```

As an MCP server for agent runtimes:

```sh
claude mcp add faden --env FADEN_API_KEY=fdn_live_… -- npx @fadenhq/cli mcp
```

And as a skill, so the agent knows how to use those tools well — check constraints before
writing, tailor per platform, read per-target results:

```sh
npx skills add fadenhq/cli     # Claude Code, Codex, Cursor, … ; -g for every project
npx skills update              # refresh the copy later
```

That installs the skill alone. Claude Code can take the plugin instead, which carries the
skill and the MCP server together:

```sh
/plugin marketplace add fadenhq/cli
/plugin install faden@faden
```

See [apps/cli/README.md](apps/cli/README.md) for the full command reference and
[plugin/](plugin/) for what the plugin contains.

## Repository layout

This repo is the public mirror of the OSS subset of the faden codebase:

- `apps/cli` — the `@fadenhq/cli` package: CLI + MCP server (`faden mcp`)
- `packages/shared` — shared types, Zod validators and the per-platform constraint matrix
  (bundled into the published artifact)
- `plugin` — Claude Code plugin: MCP config + posting skill

The faden service itself (API, connectors, dashboard) is proprietary; get an API key at
[faden.io](https://faden.io). Issues and PRs for the CLI/MCP surface are welcome here.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build -w @fadenhq/cli    # bundles dist/index.js via tsup
```

Releases: maintainers push a `cli-v<version>` tag matching `apps/cli/package.json`;
`.github/workflows/release.yml` publishes to npm via trusted publishing (OIDC) with
provenance.

## License

[AGPL-3.0-only](LICENSE).
