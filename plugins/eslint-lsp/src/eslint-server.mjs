/**
 * eslint-lsp: Minimal ESLint Language Server for Claude Code
 *
 * Implements a subset of LSP sufficient to push ESLint diagnostics to Claude:
 *   textDocument/didOpen|didChange → ESLint.lintText() → publishDiagnostics
 *
 * Design decisions:
 * - Uses the PROJECT's ESLint installation (not bundled), so version and config
 *   are always in sync with the user's project.
 * - Resolves ESLint from each file's nearest package root (supports monorepos).
 * - 300ms debounce prevents redundant lints during rapid edits.
 * - Watches flat config files and clears ESLint cache on change.
 * - On ESLint v9: disables type-aware parsing (parserOptions.project: false) to
 *   avoid the scopeManager.addGlobals incompatibility with @typescript-eslint.
 *   Non-type-aware rules (the majority) still run correctly.
 * - On ESLint v10+: full config, all rules active.
 */

import { createRequire } from 'node:module'
import { existsSync, watch } from 'node:fs'
import { resolve } from 'node:path'

// ─── LSP JSON-RPC framing (Content-Length header over stdio) ─────────────────

let _buf = ''
let _len = -1

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  _buf += chunk
  while (true) {
    if (_len === -1) {
      const sep = _buf.indexOf('\r\n\r\n')
      if (sep === -1) break
      const m = _buf.slice(0, sep).match(/Content-Length:\s*(\d+)/i)
      if (!m) break
      _len = +m[1]
      _buf = _buf.slice(sep + 4)
    }
    if (_buf.length < _len) break
    try { dispatch(JSON.parse(_buf.slice(0, _len))) } catch { /* malformed JSON — ignore and continue */ }
    _buf = _buf.slice(_len)
    _len = -1
  }
})

function send(msg) {
  const body = JSON.stringify(msg)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
}

function publishDiagnostics(uri, diagnostics) {
  send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } })
}

// ─── Flat config file names (ESLint v9+ official list from source) ───────────

const FLAT_CONFIGS = [
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
  'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts',
]

// ─── Package root resolution ─────────────────────────────────────────────────

/**
 * Walk up from filePath to find the nearest directory containing an ESLint
 * flat config file. Supports monorepos where each package has its own config.
 */
function findPkgRoot(filePath) {
  const segments = filePath.split('/')
  for (let i = segments.length - 1; i > 0; i--) {
    const dir = segments.slice(0, i).join('/')
    if (!dir) continue
    for (const name of FLAT_CONFIGS) {
      if (existsSync(`${dir}/${name}`)) return dir
    }
  }
  return null
}

// ─── ESLint instance cache (per package root) ─────────────────────────────────

/** @type {Map<string, { instance: import('eslint').ESLint, major: number }>} */
const eslintCache = new Map()
/** @type {Map<string, import('node:fs').FSWatcher[]>} */
const configWatchers = new Map()

/**
 * Load or return cached ESLint instance for a package root.
 * Uses the PROJECT's ESLint, not any bundled version.
 *
 * For ESLint v9: applies parserOptions.project=false override to avoid the
 * scopeManager.addGlobals incompatibility introduced by @typescript-eslint
 * when type-aware parsing is enabled. Non-type-aware rules are unaffected.
 */
function getESLint(pkgRoot) {
  if (eslintCache.has(pkgRoot)) return eslintCache.get(pkgRoot)

  // Resolve `eslint` from the user's project, not from the plugin directory.
  const req = createRequire(resolve(pkgRoot, 'package.json'))
  let ESLint, major
  try {
    ;({ ESLint } = req('eslint'))
    major = parseInt(req('eslint/package.json').version, 10)
  } catch {
    // ESLint not installed in this package — skip silently.
    return null
  }

  // v9: disable type-aware parsing to avoid scopeManager.addGlobals errors.
  // v10+: use full config (scopeManager API is compatible).
  const overrides = major < 10
    ? [{ languageOptions: { parserOptions: { project: false } } }]
    : []

  const instance = new ESLint({ cwd: pkgRoot, overrideConfig: overrides })
  eslintCache.set(pkgRoot, { instance, major })
  watchConfigs(pkgRoot)
  return { instance, major }
}

/**
 * Watch ESLint flat config files and evict the ESLint instance on change
 * so the next lint picks up the updated configuration.
 */
function watchConfigs(pkgRoot) {
  if (configWatchers.has(pkgRoot)) return
  const watchers = []
  for (const name of FLAT_CONFIGS) {
    const configPath = resolve(pkgRoot, name)
    if (!existsSync(configPath)) continue
    try {
      const w = watch(configPath, { persistent: false }, () => {
        eslintCache.delete(pkgRoot)
      })
      watchers.push(w)
    } catch { /* file disappeared between existsSync and watch */ }
  }
  if (watchers.length) configWatchers.set(pkgRoot, watchers)
}

// ─── Lint execution with debounce ─────────────────────────────────────────────

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const debounce = new Map()

function scheduleLint(uri, text) {
  clearTimeout(debounce.get(uri))
  debounce.set(uri, setTimeout(() => runLint(uri, text), 300))
}

async function runLint(uri, text) {
  const filePath = uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri
  if (!/\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/.test(filePath)) return

  const pkgRoot = findPkgRoot(filePath)
  if (!pkgRoot) return

  const cached = getESLint(pkgRoot)
  if (!cached) return

  const { instance: eslint, major } = cached

  let results
  try {
    results = await eslint.lintText(text, { filePath })
  } catch (err) {
    // Surface the failure as a visible warning diagnostic instead of silently
    // clearing diagnostics. This ensures Claude (and the developer) can see
    // that ESLint failed rather than incorrectly assuming the file is clean.
    const msg = err?.message ?? String(err)
    const isScopeError = /addGlobals|scopeManager/i.test(msg)
    publishDiagnostics(uri, [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 2, // Warning
      source: 'eslint-lsp',
      code: 'eslint-lsp/config-error',
      message: isScopeError
        ? `eslint-lsp: ESLint v${major} scope manager error — ${msg}. Upgrade to ESLint v10 for full compatibility.`
        : `eslint-lsp: ESLint failed to lint this file — ${msg}`,
    }])
    return
  }

  const messages = results[0]?.messages ?? []
  const diagnostics = messages.map((m) => ({
    range: {
      start: { line: Math.max(0, (m.line ?? 1) - 1),    character: Math.max(0, (m.column ?? 1) - 1) },
      end:   { line: Math.max(0, (m.endLine ?? m.line ?? 1) - 1), character: Math.max(0, (m.endColumn ?? m.column ?? 1) - 1) },
    },
    // LSP severity: 1 = Error, 2 = Warning
    severity: m.severity === 2 ? 1 : 2,
    source: 'eslint',
    code: m.ruleId ?? undefined,
    message: m.ruleId ? `${m.message}  [${m.ruleId}]` : m.message,
  }))

  publishDiagnostics(uri, diagnostics)
}

// ─── LSP message dispatcher ───────────────────────────────────────────────────

function dispatch(msg) {
  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          capabilities: {
            textDocumentSync: 1, // TextDocumentSyncKind.Full
          },
          serverInfo: { name: 'eslint-lsp', version: '0.2.0' },
        },
      })
      break

    case 'initialized':
      break // no-op, server ready

    case 'textDocument/didOpen':
      scheduleLint(msg.params.textDocument.uri, msg.params.textDocument.text)
      break

    case 'textDocument/didChange': {
      // contentChanges is an array; last entry has the full text (Full sync mode).
      const text = msg.params.contentChanges.at(-1)?.text ?? ''
      scheduleLint(msg.params.textDocument.uri, text)
      break
    }

    case 'textDocument/didClose': {
      const { uri } = msg.params.textDocument
      clearTimeout(debounce.get(uri))
      debounce.delete(uri)
      // Clear diagnostics so stale errors don't persist after file is closed.
      publishDiagnostics(uri, [])
      break
    }

    case 'shutdown':
      send({ jsonrpc: '2.0', id: msg.id, result: null })
      break

    case 'exit':
      process.exit(0)

    default:
      // All unknown requests MUST receive a response to prevent client timeout.
      if (msg.id != null) send({ jsonrpc: '2.0', id: msg.id, result: null })
  }
}
