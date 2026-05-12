# ts-eslint-lsp

TypeScript LSP proxy with unified real-time ESLint diagnostics for Claude Code.

## Why this exists

When Claude writes code, it has no visibility into ESLint rule violations until you manually run `lint`. The fix cycle becomes: Claude writes code → you run `pnpm lint` → you paste errors back → Claude fixes → repeat every session.

Claude Code has a built-in LSP client. If an LSP server pushes `publishDiagnostics` notifications, Claude sees those diagnostics in the same turn it edits code — and can fix violations immediately without any manual step.

The natural solution is to run `typescript-lsp` (for type intelligence) and `eslint-lsp` (for lint diagnostics) side by side. But there's a hard constraint.

### The single-server-per-extension constraint

Claude Code's LSP router, confirmed from the 2.1.139 binary:

```javascript
function getServerForFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  const servers = extensionMap.get(ext);
  return servers[0]; // only the first registered server receives messages
}
```

When two plugins declare the same extension (e.g. `.ts`), only one is active. Installing both `typescript-lsp@claude-plugins-official` and `eslint-lsp` means one of them is silently ignored.

### How this plugin solves it

One proxy server does both jobs:

1. **TypeScript proxy** — all LSP requests (`go-to-definition`, `hover`, `references`, completions, type errors) are forwarded to a `typescript-language-server` child process and its responses are passed back transparently.
2. **ESLint diagnostics** — on every `didOpen`/`didChange`, ESLint runs against the document content and pushes diagnostics via `publishDiagnostics`.

Both sets of diagnostics (TypeScript type errors + ESLint rule violations) are merged and delivered in a single `publishDiagnostics` notification.

## Prerequisites

- Node.js 18+
- `typescript-language-server` reachable from the project directory (in `node_modules/.bin/`) or on `$PATH`
- ESLint v9+ with flat config (`eslint.config.*`) in the project

## Installation

```
/plugin install ts-eslint-lsp
/reload-plugins
```

## ⚠️ Disable `typescript-lsp` before using this plugin

Because of the single-server-per-extension constraint, `typescript-lsp@claude-plugins-official` and `ts-eslint-lsp` cannot coexist for `.ts`/`.tsx` files. Disable the official plugin first:

```
/plugin disable typescript-lsp
/reload-plugins
```

Or set it in `.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "typescript-lsp@claude-plugins-official": false
  }
}
```

The same applies to `eslint-lsp` from this plugin collection — `ts-eslint-lsp` already includes ESLint, so running both would double-report ESLint diagnostics. Disable `eslint-lsp` if you have it enabled.

## Relationship to `eslint-lsp`

| Plugin | What it provides | When to use |
|---|---|---|
| `eslint-lsp` | ESLint diagnostics only | When you don't need TypeScript language features in Claude |
| `ts-eslint-lsp` | TypeScript language features + ESLint diagnostics | The standard choice for TypeScript projects |

Both use the project's own ESLint installation, so your version and config are always respected.

## How it works

```
Claude Code (stdin/stdout)
    ↕ JSON-RPC
[ts-eslint-proxy.mjs]
    ├── child process: typescript-language-server --stdio
    │   forwards: initialize, initialized, didOpen, didChange, definition,
    │             hover, references, completions, shutdown, exit, ...
    │   intercepts: publishDiagnostics → stores in diagMap.ts
    └── ESLint (project's own installation)
         runs on: didOpen, didChange (300ms debounce)
         result → diagMap.eslint
         either side updates → merged publishDiagnostics sent to Claude
```

- **Monorepo-aware**: resolves ESLint from the nearest `eslint.config.*` walking up from each file.
- **ESLint v9+ flat config** support. ESLint v9 disables type-aware parsing to avoid a `scopeManager.addGlobals` incompatibility with older `@typescript-eslint` versions; non-type-aware rules still run. ESLint v10+ runs with full config.
- **Graceful degradation**: if `typescript-language-server` crashes, the proxy continues running and ESLint diagnostics keep flowing.

## Supported file types

`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`
