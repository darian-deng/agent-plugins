# eslint-lsp

Real-time ESLint diagnostics for **Claude Code** via a lightweight LSP server.

## What it does

When you install this plugin, Claude Code gets the same write-time ESLint awareness
as your IDE — without waiting for a manual `lint` run or a pre-commit hook.

```
Claude edits a file
  → LSP server runs ESLint on the new content (300ms debounce)
  → Violations pushed to Claude via textDocument/publishDiagnostics
  → Claude sees the error in the same turn and fixes it immediately
```

Also bundled: **`@eslint/mcp`** — ESLint's official MCP server, registered
automatically when the plugin is enabled. Claude can call it on-demand for
mechanical autofixes (`eslint --fix` equivalent).

## Requirements

- Claude Code **≥ 2.1.5** (LSP plugin support)
- Node.js **≥ 18**
- ESLint **v9+** with flat config (`eslint.config.{js,mjs,cjs}`) installed in your project
- The project's `eslint` package must be in `node_modules` (the server uses your project's ESLint, not a bundled one)

## Installation

```bash
# 1. Add this marketplace to Claude Code
/plugin marketplace add darian-deng/agent-plugins

# 2. Install the plugin
/plugin install eslint-lsp@darian-agent-plugins
```

## Monorepo support

The server walks up the directory tree from each edited file and finds the
nearest `eslint.config.*`. This means each package in a monorepo gets its own
ESLint configuration — no extra setup needed.

## Cursor support

Cursor's plugin system does not support LSP server registration (LSP is handled
by VS Code extensions there). However, the bundled `@eslint/mcp` **does** work
in Cursor via its MCP plugin system. Cursor users get ESLint as an AI-callable
tool rather than passive push diagnostics.

Submit separately to the Cursor marketplace: `cursor.com/marketplace/publish`

## How it works

### LSP Server (`src/eslint-server.mjs`)

A ~130-line Node.js implementation of the LSP subset needed for diagnostics:

| LSP message | Action |
|---|---|
| `textDocument/didOpen` | Schedule lint (300ms debounce) |
| `textDocument/didChange` | Schedule lint (300ms debounce) |
| `textDocument/didClose` | Clear diagnostics |
| `textDocument/publishDiagnostics` | Push ESLint results to Claude |

The server resolves ESLint from **your project's `node_modules`**, not a bundled
version, so your ESLint version and config are always respected.

### `@eslint/mcp` (MCP server)

Registered automatically via `.mcp.json`. Claude can call:
- `eslint_check` — run ESLint on a file and get structured results
- `eslint_fix` — apply `--fix` to a file

Useful for mechanical fixes where ESLint knows the correct transformation.

### Config hot-reload

When you modify `eslint.config.*`, the server detects the change via `fs.watch`
and evicts the cached ESLint instance. The next lint automatically reloads your
updated configuration.

## Supported config files

All ESLint v9+ flat config file names are watched:

```
eslint.config.js   eslint.config.ts
eslint.config.mjs  eslint.config.mts
eslint.config.cjs  eslint.config.cts
```

Legacy `.eslintrc.*` files are not supported (ESLint v9+ flat config only).

## Known limitations

- **Type-aware rules**: On first lint per session, TypeScript program initialization
  adds ~1–3 seconds. Subsequent lints are fast (100–300ms). This is structural
  to how `@typescript-eslint/parser` works.

- **Intermediate state**: During multi-file refactors, some rules may report
  false positives while files are being updated. Single-file rules (the majority)
  are not affected. Add a note in `CLAUDE.md` to help Claude reason about this:

  ```markdown
  When doing multi-file refactors, ESLint diagnostics may show false positives
  on intermediate states. If you plan to update the referenced file, continue
  the refactor — the diagnostic will clear when all files are updated.
  ```

## Publishing

### Claude Code official marketplace

Submit at: `https://claude.ai/settings/plugins/submit`

### Cursor marketplace

Submit at: `https://cursor.com/marketplace/publish`
(Cursor benefits from the `@eslint/mcp` MCP server, not the LSP server)

## License

MIT
