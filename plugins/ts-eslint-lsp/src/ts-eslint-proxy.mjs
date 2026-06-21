#!/usr/bin/env node

import { createRequire } from 'node:module'
import { existsSync, watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { spawn } from 'node:child_process'

// ─── JSON-RPC framing ─────────────────────────────────────────────────────────

// Frame buffer is a Buffer (not a JS string): Content-Length is a UTF-8 BYTE count,
// so length comparison and slicing must be byte-based. Using a string + `.length`
// (UTF-16 code-unit count) under-counts multi-byte characters (e.g. CJK), making
// `buf.length < len` perpetually true → the frame never completes and every
// subsequent request stalls. See regression: opening a file with CJK comments.
function makeFrameParser(onMessage) {
  let buf = Buffer.alloc(0)
  let len = -1
  return (chunk) => {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')])
    while (true) {
      if (len === -1) {
        const sep = buf.indexOf('\r\n\r\n')
        if (sep === -1) break
        const m = buf.subarray(0, sep).toString('utf8').match(/Content-Length:\s*(\d+)/i)
        if (!m) { buf = buf.subarray(sep + 4); continue } // skip unrecognised header block
        len = +m[1]
        buf = buf.subarray(sep + 4)
      }
      if (buf.length < len) break // buf.length is now a byte count, matching Content-Length
      try { onMessage(JSON.parse(buf.subarray(0, len).toString('utf8'))) } catch { /* malformed — skip */ }
      buf = buf.subarray(len)
      len = -1
    }
  }
}

function frame(msg) {
  const body = JSON.stringify(msg)
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`
}

function sendToClient(methodOrMsg, params) {
  const msg = params !== undefined
    ? { jsonrpc: '2.0', method: methodOrMsg, params }
    : methodOrMsg
  process.stdout.write(frame(msg))
}

// ─── TypeScript Language Server child process ─────────────────────────────────

function findTsBin(startDir) {
  let dir = startDir
  while (true) {
    const candidate = join(dir, 'node_modules', '.bin', 'typescript-language-server')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const tsBin = findTsBin(process.cwd()) ?? 'typescript-language-server'

let tsServerAlive = true

const tsServer = spawn(tsBin, ['--stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
})

tsServer.stderr.on('data', () => { /* suppress ts-server stderr noise */ })

// Resilience: tls may fail to spawn (binary missing) or die mid-flight. Without an
// 'error' handler the EPIPE on a broken stdin pipe is an unhandled 'error' event and
// crashes the whole proxy — defeating the degraded-mode design goal (ESLint should
// keep working even if TypeScript intelligence is gone). Mark tls dead instead.
function markTsServerDead(reason) {
  if (!tsServerAlive) return
  tsServerAlive = false
  for (const [, { reject, timer }] of pendingRequests) {
    clearTimeout(timer)
    reject(new Error(reason))
  }
  pendingRequests.clear()
  clientToProxy.clear()
  // Degraded mode: ESLint diagnostics continue, TypeScript intelligence unavailable.
}

tsServer.on('error', () => markTsServerDead('typescript-language-server spawn/runtime error'))
tsServer.stdin.on('error', () => markTsServerDead('typescript-language-server stdin error (EPIPE)'))
tsServer.on('close', () => markTsServerDead('typescript-language-server exited'))

// Pending request map: proxyId → { clientId, resolve, reject, timer }
const pendingRequests = new Map()
// Reverse map: clientId → proxyId, so $/cancelRequest (which carries the client id)
// can be translated to the proxyId the tls actually knows the request by.
// Assumption: the client never reuses one id across two simultaneously in-flight requests
// (LSP/JSON-RPC requires in-flight request ids to be unique). If it did, the later set()
// would overwrite the earlier mapping and a cancel could only reach the most recent one —
// a known limitation that only triggers on a protocol-violating client.
const clientToProxy = new Map()
let _nextProxyId = 1

// A request that tls never answers must not pend forever (that is exactly how the
// whole channel "hung" before). Fail it after a ceiling so the caller degrades to null.
const REQUEST_TIMEOUT_MS = Number(process.env.TS_ESLINT_PROXY_TIMEOUT_MS) || 15000

function sendToTsServer(msg) {
  if (!tsServerAlive) return
  // Guard the write: a race between "pipe broke" and the async 'close'/'error' event
  // can let a write through onto a dead pipe → synchronous throw / EPIPE.
  try {
    tsServer.stdin.write(frame(msg))
  } catch {
    markTsServerDead('typescript-language-server write failed')
  }
}

tsServer.stdout.on('data', makeFrameParser((msg) => {
  // Notifications (no id): diagnostics are merged with ESLint output, the rest pass through.
  if (msg.id == null) {
    if (msg.method === 'textDocument/publishDiagnostics') {
      const uri = msg.params?.uri
      if (uri) {
        const entry = diagMap.get(uri) ?? { ts: [], eslint: [] }
        // Drop UNUSED-code SUGGESTION diagnostics (severity Hint=4). tsserver always computes these
        // regardless of tsconfig; when the project does NOT enable noUnusedLocals/noUnusedParameters,
        // `tsc` never reports them, so surfacing them only tempts edits the project policy
        // deliberately allows. Match by the unused-suggestion codes (tls does not reliably attach the
        // Unnecessary tag) OR an explicit Unnecessary tag. Real unused-as-ERROR (flag on) is severity
        // 1 → kept. Other Hints (e.g. deprecations) → kept.
        entry.ts = (msg.params.diagnostics ?? []).filter(
          (d) => !(d.severity === 4 && (TS_UNUSED_SUGGESTION_CODES.has(Number(d.code)) || (Array.isArray(d.tags) && d.tags.includes(1)))),
        )
        diagMap.set(uri, entry)
        mergeDiagnostics(uri)
        // A TS publish is frequently a dependency-driven re-check of a file we did NOT just edit.
        // The ESLint half only refreshes on this uri's own didOpen/didChange, so re-broadcasting it
        // here can resurrect a STALE diagnostic (e.g. a prettier warning already fixed on disk by a
        // CLI formatter, never seen as a didChange). If we're holding any ESLint diagnostics for this
        // uri, re-lint from disk (debounced + content-deduped) so the stale half self-corrects.
        // Assumes disk content is authoritative for the file — true for clients that write edits
        // straight to disk (e.g. Claude Code); a client with unsaved in-memory buffers could see a
        // brief disk-based ESLint result until its next didChange re-lints the buffer.
        if (entry.eslint.length) scheduleDiskRelint(uri)
      }
      return
    }
    sendToClient(msg)
    return
  }

  // Server→client REQUEST (has id AND method): forward to the client untouched. Its id
  // is the tls's own id (we don't rewrite it), so the client's reply carries the same id
  // and the client-side dispatcher forwards that reply straight back to tls.
  // NOTE: this branch must come before the response lookup — otherwise a server→client
  // request whose id happens to collide with an outstanding proxyId would be misrouted
  // as if it were a response.
  if (msg.method != null) {
    sendToClient(msg)
    return
  }

  // Response (has id, no method): route back to the awaiting promise (msg.id is the proxyId)
  if (pendingRequests.has(msg.id)) {
    const { clientId, resolve, timer } = pendingRequests.get(msg.id)
    clearTimeout(timer)
    pendingRequests.delete(msg.id)
    if (clientId != null) clientToProxy.delete(clientId)
    resolve({ ...msg, id: clientId })
    return
  }

  // Unknown / late response (e.g. arrived after our timeout already rejected it): drop it.
  // Passing it through would emit an orphan response carrying a proxyId the client never sent.
}))

function requestTsServer(msg) {
  return new Promise((resolve, reject) => {
    const proxyId = _nextProxyId++
    if (msg.id != null) clientToProxy.set(msg.id, proxyId)
    const timer = setTimeout(() => {
      if (pendingRequests.has(proxyId)) {
        pendingRequests.delete(proxyId)
        if (msg.id != null) clientToProxy.delete(msg.id)
        reject(new Error(`tsserver request timed out after ${REQUEST_TIMEOUT_MS}ms: ${msg.method}`))
      }
    }, REQUEST_TIMEOUT_MS)
    pendingRequests.set(proxyId, { clientId: msg.id, resolve, reject, timer })
    sendToTsServer({ ...msg, id: proxyId })
  })
}

// ─── Diagnostic merge map ─────────────────────────────────────────────────────

const diagMap = new Map() // uri → { ts: Diagnostic[], eslint: Diagnostic[] }

// TypeScript "unused code" suggestion diagnostic codes. Reported at severity Hint when the project
// does NOT enable noUnusedLocals/noUnusedParameters (so `tsc` never errors on them); reported at
// severity Error when it does (different severity → not matched here, correctly kept).
const TS_UNUSED_SUGGESTION_CODES = new Set([6133, 6192, 6196, 6198, 6199, 6205])

function mergeDiagnostics(uri) {
  const entry = diagMap.get(uri) ?? { ts: [], eslint: [] }
  sendToClient('textDocument/publishDiagnostics', {
    uri,
    diagnostics: [...entry.ts, ...entry.eslint],
  })
}

// ─── ESLint (ported from eslint-server.mjs) ───────────────────────────────────

const FLAT_CONFIGS = [
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
  'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts',
]

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

const eslintCache = new Map()
const configWatchers = new Map()

function getESLint(pkgRoot) {
  if (eslintCache.has(pkgRoot)) return eslintCache.get(pkgRoot)

  const req = createRequire(resolve(pkgRoot, 'package.json'))
  let ESLint, major
  try {
    ;({ ESLint } = req('eslint'))
    major = parseInt(req('eslint/package.json').version, 10)
  } catch {
    return null
  }

  const overrides = major >= 10
    ? [{ languageOptions: { parserOptions: { project: false } } }]
    : []

  const instance = new ESLint({ cwd: pkgRoot, overrideConfig: overrides })
  eslintCache.set(pkgRoot, { instance, major })
  watchConfigs(pkgRoot)
  return { instance, major }
}

function watchConfigs(pkgRoot) {
  if (configWatchers.has(pkgRoot)) return
  const watchers = []
  for (const name of FLAT_CONFIGS) {
    const configPath = resolve(pkgRoot, name)
    if (!existsSync(configPath)) continue
    try {
      const w = watch(configPath, { persistent: false }, () => {
        eslintCache.delete(pkgRoot)
        // Drop the watcher registration too, so the next getESLint() rebuilds both the
        // ESLint instance AND the watcher set (otherwise a newly-added config file at
        // this pkgRoot would never be picked up — watchConfigs early-returns on `has`).
        const ws = configWatchers.get(pkgRoot)
        if (ws) { for (const x of ws) { try { x.close() } catch {} } }
        configWatchers.delete(pkgRoot)
      })
      watchers.push(w)
    } catch { /* file disappeared */ }
  }
  if (watchers.length) configWatchers.set(pkgRoot, watchers)
}

function closeAllWatchers() {
  for (const ws of configWatchers.values()) {
    for (const w of ws) { try { w.close() } catch {} }
  }
  configWatchers.clear()
}

const lintDebounce = new Map()
const uriGeneration = new Map() // uri → generation counter; incremented on didClose
const lintSeq = new Map()       // uri → monotonic lint sequence; guards against out-of-order overwrite

// Real debounce delay: collapses bursts of didChange into a single lint. A 0ms timeout
// did not debounce at all (every keystroke spawned an overlapping runLint).
const LINT_DEBOUNCE_MS = 150

function scheduleLint(uri, text) {
  clearTimeout(lintDebounce.get(uri))
  lintDebounce.set(uri, setTimeout(() => runLint(uri, text ?? '').catch(() => {}), LINT_DEBOUNCE_MS))
}

// Debounced re-lint that reads the file from DISK (not from an LSP text param). Used when a TS
// re-check signals the file may have changed underneath a stale ESLint half. Separate debounce map
// from scheduleLint so it never cancels a pending didChange-driven lint. runLint's own
// generation/seq guards make a late completion (e.g. after didClose) a no-op.
const diskRelintDebounce = new Map()
const diskRelintHash = new Map() // uri → hash of the disk content we last re-linted
// Cheap 32-bit string hash (djb2). Only used to skip redundant re-lints; a collision merely skips
// one re-lint, never produces a wrong diagnostic.
function hashText(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0
  return h
}
function scheduleDiskRelint(uri) {
  clearTimeout(diskRelintDebounce.get(uri))
  diskRelintDebounce.set(uri, setTimeout(() => {
    diskRelintDebounce.delete(uri)
    const filePath = uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri
    readFile(filePath, 'utf8').then((text) => {
      // didClose may have arrived during the readFile hop — it deletes diagMap[uri]. Bail so we
      // don't re-publish ESLint diagnostics onto an already-closed file. (runLint captures its
      // generation guard only AFTER this async hop, so it cannot catch this window on its own.)
      if (!diagMap.has(uri)) return
      // A dependency-driven TS re-check fires often, but the file's own bytes rarely changed since
      // our last disk re-lint. Skip the (expensive) ESLint run when the content is identical — this
      // bounds the cost to one readFile + hash, not a full lint, on every downstream re-check.
      // This assumes a file's lint result depends only on its own bytes — true for the syntactic
      // rules in use (type-aware @typescript-eslint rules are off: getESLint forces project:false on
      // ESLint v10). If type-aware rules were enabled, a dependency change could alter this file's
      // result with its bytes unchanged; the dedup would briefly miss it until the next didChange.
      const h = hashText(text)
      if (diskRelintHash.get(uri) === h) return
      diskRelintHash.set(uri, h)
      return runLint(uri, text)
    }).catch(() => {})
  }, LINT_DEBOUNCE_MS))
}

async function runLint(uri, text) {
  const filePath = uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri
  if (!/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(filePath)) return

  const pkgRoot = findPkgRoot(filePath)
  if (!pkgRoot) return

  const cached = getESLint(pkgRoot)
  if (!cached) return

  const { instance: eslint, major } = cached
  const entry = diagMap.get(uri) ?? { ts: [], eslint: [] }

  // Capture generation before async work; abort if file was closed while awaiting
  const gen = uriGeneration.get(uri) ?? 0
  // Capture a per-lint sequence; abort if a newer lint for this uri started while awaiting
  // (debounce alone cannot cancel a lint already inside `await eslint.lintText`).
  const seq = (lintSeq.get(uri) ?? 0) + 1
  lintSeq.set(uri, seq)

  let results
  try {
    results = await eslint.lintText(text, { filePath })
  } catch (err) {
    if ((uriGeneration.get(uri) ?? 0) !== gen) return // file was closed while awaiting
    if ((lintSeq.get(uri) ?? 0) !== seq) return        // superseded by a newer lint
    const msg = err?.message ?? String(err)
    const isScopeError = /addGlobals|scopeManager/i.test(msg)
    entry.eslint = [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 2,
      source: 'eslint-lsp',
      code: 'eslint-lsp/config-error',
      message: isScopeError
        ? `eslint-lsp: ESLint v${major} scope manager error — ${msg}. Upgrade @typescript-eslint to v8+ for ESLint v10 compatibility.`
        : `eslint-lsp: ESLint failed to lint this file — ${msg}`,
    }]
    diagMap.set(uri, entry)
    mergeDiagnostics(uri)
    return
  }

  if ((uriGeneration.get(uri) ?? 0) !== gen) return // file was closed while awaiting
  if ((lintSeq.get(uri) ?? 0) !== seq) return        // superseded by a newer lint

  const messages = results[0]?.messages ?? []
  entry.eslint = messages.map((m) => ({
    range: {
      start: { line: Math.max(0, (m.line ?? 1) - 1),    character: Math.max(0, (m.column ?? 1) - 1) },
      end:   { line: Math.max(0, (m.endLine ?? m.line ?? 1) - 1), character: Math.max(0, (m.endColumn ?? m.column ?? 1) - 1) },
    },
    severity: m.severity === 2 ? 1 : 2,
    source: 'eslint',
    code: m.ruleId ?? undefined,
    message: m.ruleId ? `${m.message}  [${m.ruleId}]` : m.message,
  }))
  diagMap.set(uri, entry)
  mergeDiagnostics(uri)
}

// ─── ESLint warm-up ───────────────────────────────────────────────────────────

let warmedUp = false

async function warmUpEslint(filePath) {
  if (warmedUp) return
  warmedUp = true
  const pkgRoot = findPkgRoot(filePath)
  if (!pkgRoot) return
  const cached = getESLint(pkgRoot)
  if (!cached) return
  const text = await readFile(filePath, 'utf8').catch(() => null)
  if (!text) return
  await cached.instance.lintText(text, { filePath }).catch(() => {})
}

// ─── Client message dispatcher ────────────────────────────────────────────────

let initializePromise = null // guard: delay 'initialized' until 'initialize' completes

process.stdin.on('data', makeFrameParser(async (msg) => {
  const { method, id } = msg

  // Client's RESPONSE to a server→client request (has id, no method): forward back to
  // tls untouched. The id is tls's own server-request id (we never rewrote it), so tls
  // matches it directly. Without this, the dispatcher below would mistake the response
  // for a brand-new request and re-issue it to tls, leaking a pendingRequests entry and
  // leaving tls's original request unanswered forever.
  if (method == null && id != null) {
    sendToTsServer(msg)
    return
  }

  if (method === 'initialize') {
    const projectDir = msg.params?.rootUri?.replace(/^file:\/\//, '') ?? process.cwd()
    if (tsServerAlive) {
      initializePromise = requestTsServer(msg).then(tsResponse => {
        // Force full-document sync (textDocumentSync: 1) in the capabilities we advertise
        // to the client. The didChange handler below assumes contentChanges carries the
        // full text; tls defaults to Incremental (2), under which the client would send
        // only deltas and ESLint would lint fragments. Rewrite change kind to full.
        const caps = tsResponse?.result?.capabilities
        if (caps) {
          if (caps.textDocumentSync != null && typeof caps.textDocumentSync === 'object') {
            caps.textDocumentSync.change = 1
          } else {
            caps.textDocumentSync = 1
          }
        }
        sendToClient(tsResponse)
      }).catch(() => {
        sendToClient({ jsonrpc: '2.0', id, result: {
          capabilities: { textDocumentSync: 1 },
          serverInfo: { name: 'ts-eslint-proxy', version: '0.1.0' },
        }})
      })
      await initializePromise
    } else {
      sendToClient({ jsonrpc: '2.0', id, result: {
        capabilities: { textDocumentSync: 1 },
        serverInfo: { name: 'ts-eslint-proxy', version: '0.1.0' },
      }})
    }
    return
  }

  if (method === 'initialized') {
    if (initializePromise) {
      initializePromise.then(() => sendToTsServer(msg)).catch(() => sendToTsServer(msg))
    } else {
      sendToTsServer(msg)
    }
    return
  }

  if (method === '$/cancelRequest') {
    // The cancel carries the CLIENT's request id, but tls knows the request by its proxyId.
    // Translate before forwarding; if it no longer maps, the request already settled — drop.
    const proxyId = clientToProxy.get(msg.params?.id)
    if (proxyId != null) {
      sendToTsServer({ ...msg, params: { ...msg.params, id: proxyId } })
    }
    return
  }

  if (method === 'textDocument/didOpen') {
    sendToTsServer(msg)
    const { uri, text } = msg.params.textDocument
    const filePath = uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri
    warmUpEslint(filePath).catch(() => {})
    scheduleLint(uri, text)
    return
  }

  if (method === 'textDocument/didChange') {
    sendToTsServer(msg)
    // contentChanges[].text is the full document because we advertise textDocumentSync:1
    // (full) in our initialize response (capabilities rewrite above). So .at(-1).text is
    // always the complete content — safe to hand straight to ESLint.
    const text = msg.params.contentChanges.at(-1)?.text ?? ''
    scheduleLint(msg.params.textDocument.uri, text)
    return
  }

  if (method === 'textDocument/didClose') {
    const uri = msg.params.textDocument.uri
    sendToTsServer(msg)
    clearTimeout(lintDebounce.get(uri))
    lintDebounce.delete(uri)
    clearTimeout(diskRelintDebounce.get(uri))
    diskRelintDebounce.delete(uri)
    diskRelintHash.delete(uri)
    diagMap.delete(uri)
    lintSeq.delete(uri)
    uriGeneration.set(uri, (uriGeneration.get(uri) ?? 0) + 1)
    sendToClient('textDocument/publishDiagnostics', { uri, diagnostics: [] })
    return
  }

  if (method === 'shutdown') {
    if (tsServerAlive) {
      try {
        const tsResponse = await requestTsServer(msg)
        sendToClient(tsResponse)
      } catch {
        sendToClient({ jsonrpc: '2.0', id, result: null })
      }
    } else {
      sendToClient({ jsonrpc: '2.0', id, result: null })
    }
    return
  }

  if (method === 'exit') {
    closeAllWatchers()
    sendToTsServer(msg)
    process.exit(0)
  }

  // All other requests: proxy to TS server if alive, otherwise return empty result
  if (id != null) {
    if (tsServerAlive) {
      try {
        const tsResponse = await requestTsServer(msg)
        sendToClient(tsResponse)
      } catch {
        sendToClient({ jsonrpc: '2.0', id, result: null })
      }
    } else {
      sendToClient({ jsonrpc: '2.0', id, result: null })
    }
  } else {
    sendToTsServer(msg)
  }
}))

// Last-resort guard: this proxy is long-lived and losing it kills all intelligence for the
// session. Keep it alive on an unexpected throw rather than crashing (degraded-mode intent).
process.on('uncaughtException', (err) => {
  try { process.stderr.write(`[ts-eslint-proxy] uncaughtException: ${err?.stack ?? err}\n`) } catch {}
})
// The client dispatcher is an async callback that makeFrameParser does NOT await, so a throw
// inside it surfaces as an unhandledRejection. Don't crash (degraded-mode intent) — but DO log
// to stderr, symmetric with uncaughtException, so a real dispatcher bug isn't silently swallowed.
process.on('unhandledRejection', (err) => {
  try { process.stderr.write(`[ts-eslint-proxy] unhandledRejection: ${err?.stack ?? err}\n`) } catch {}
})

// Signal teardown: Claude Code typically tears an LSP server down via SIGTERM/SIGINT, not the
// LSP `exit` notification. Without this, the spawned tls child is orphaned (real process leak)
// and config watchers stay open. Mirror the `exit` handler's cleanup for the signal path.
function shutdownProxy() {
  closeAllWatchers()
  try { tsServer.kill() } catch {}
  process.exit(0)
}
process.on('SIGTERM', shutdownProxy)
process.on('SIGINT', shutdownProxy)

// Client teardown via stream, not signal: when the client closes our stdin (EOF) or the
// stdout pipe breaks, the client is gone. Tear down rather than lingering — otherwise the
// proxy survives as a zombie (its event loop kept alive by the tls child's stdout pipe) and
// the tls child is orphaned. Standard LSP behaviour: exit when stdin closes.
process.stdin.on('end', shutdownProxy)
process.stdout.on('error', shutdownProxy)
