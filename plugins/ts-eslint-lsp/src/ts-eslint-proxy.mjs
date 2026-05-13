#!/usr/bin/env node

import { createRequire } from 'node:module'
import { existsSync, watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { spawn } from 'node:child_process'

// ─── JSON-RPC framing ─────────────────────────────────────────────────────────

function makeFrameParser(onMessage) {
  let buf = ''
  let len = -1
  return (chunk) => {
    buf += chunk
    while (true) {
      if (len === -1) {
        const sep = buf.indexOf('\r\n\r\n')
        if (sep === -1) break
        const m = buf.slice(0, sep).match(/Content-Length:\s*(\d+)/i)
        if (!m) break
        len = +m[1]
        buf = buf.slice(sep + 4)
      }
      if (buf.length < len) break
      try { onMessage(JSON.parse(buf.slice(0, len))) } catch { /* malformed — skip */ }
      buf = buf.slice(len)
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

const tsServer = spawn(tsBin, ['--stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
})

tsServer.stderr.on('data', () => { /* suppress ts-server stderr noise */ })

tsServer.on('close', () => {
  tsServerAlive = false
  for (const [, { reject }] of pendingRequests) {
    reject(new Error('typescript-language-server exited'))
  }
  pendingRequests.clear()
  // Degraded mode: ESLint diagnostics continue, TypeScript intelligence unavailable.
})

let tsServerAlive = true

// Pending request map: proxyId → { clientId, resolve, reject }
const pendingRequests = new Map()
let _nextProxyId = 1

function sendToTsServer(msg) {
  if (!tsServerAlive) return
  tsServer.stdin.write(frame(msg))
}

tsServer.stdout.setEncoding('utf8')
tsServer.stdout.on('data', makeFrameParser((msg) => {
  if (msg.method === 'textDocument/publishDiagnostics') {
    const uri = msg.params?.uri
    if (uri) {
      const entry = diagMap.get(uri) ?? { ts: [], eslint: [] }
      entry.ts = msg.params.diagnostics ?? []
      diagMap.set(uri, entry)
      mergeDiagnostics(uri)
    }
    return
  }

  // Route response back to awaiting promise (msg.id here is the proxyId)
  if (msg.id != null && pendingRequests.has(msg.id)) {
    const { clientId, resolve } = pendingRequests.get(msg.id)
    pendingRequests.delete(msg.id)
    resolve({ ...msg, id: clientId })
    return
  }

  // All other notifications and responses pass through to the client
  sendToClient(msg)
}))

function requestTsServer(msg) {
  return new Promise((resolve, reject) => {
    const proxyId = _nextProxyId++
    pendingRequests.set(proxyId, { clientId: msg.id, resolve, reject })
    sendToTsServer({ ...msg, id: proxyId })
  })
}

// ─── Diagnostic merge map ─────────────────────────────────────────────────────

const diagMap = new Map() // uri → { ts: Diagnostic[], eslint: Diagnostic[] }

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
      })
      watchers.push(w)
    } catch { /* file disappeared */ }
  }
  if (watchers.length) configWatchers.set(pkgRoot, watchers)
}

const lintDebounce = new Map()
const uriGeneration = new Map() // uri → generation counter; incremented on didClose

function scheduleLint(uri, text) {
  clearTimeout(lintDebounce.get(uri))
  lintDebounce.set(uri, setTimeout(() => runLint(uri, text), 0))
}

async function runLint(uri, text) {
  const filePath = uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri
  if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) return

  const pkgRoot = findPkgRoot(filePath)
  if (!pkgRoot) return

  const cached = getESLint(pkgRoot)
  if (!cached) return

  const { instance: eslint, major } = cached
  const entry = diagMap.get(uri) ?? { ts: [], eslint: [] }

  // Capture generation before async work; abort if file was closed while awaiting
  const gen = uriGeneration.get(uri) ?? 0

  let results
  try {
    results = await eslint.lintText(text, { filePath })
  } catch (err) {
    if ((uriGeneration.get(uri) ?? 0) !== gen) return // file was closed while awaiting
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

async function warmUpEslint(projectDir) {
  const dir = resolve(projectDir)
  const pkgRoot = findPkgRoot(join(dir, '_'))  // find config from project root
  if (!pkgRoot) return
  const cached = getESLint(pkgRoot)
  if (!cached) return
  // find first .ts file in src/ or the project root to lint
  const { readdir } = await import('node:fs/promises')
  const candidates = ['src', '.']
  for (const sub of candidates) {
    const target = join(dir, sub)
    let entries
    try { entries = await readdir(target, { recursive: true }) } catch { continue }
    const first = entries.find(e => /\.tsx?$/.test(e) && !e.includes('node_modules'))
    if (!first) continue
    const filePath = join(target, first)
    const text = await readFile(filePath, 'utf8').catch(() => null)
    if (!text) continue
    await cached.instance.lintText(text, { filePath }).catch(() => {})
    return
  }
}

// ─── Client message dispatcher ────────────────────────────────────────────────

let initializePromise = null // guard: delay 'initialized' until 'initialize' completes

process.stdin.setEncoding('utf8')
process.stdin.on('data', makeFrameParser(async (msg) => {
  const { method, id } = msg

  if (method === 'initialize') {
    const projectDir = msg.params?.rootUri?.replace(/^file:\/\//, '') ?? process.cwd()
    if (tsServerAlive) {
      initializePromise = requestTsServer(msg).then(tsResponse => {
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
    warmUpEslint(projectDir).catch(() => {})
    return
  }

  if (method === 'initialized') {
    if (initializePromise) {
      initializePromise.then(() => sendToTsServer(msg))
    } else {
      sendToTsServer(msg)
    }
    return
  }

  if (method === 'textDocument/didOpen') {
    sendToTsServer(msg)
    scheduleLint(msg.params.textDocument.uri, msg.params.textDocument.text)
    return
  }

  if (method === 'textDocument/didChange') {
    sendToTsServer(msg)
    const text = msg.params.contentChanges.at(-1)?.text ?? ''
    scheduleLint(msg.params.textDocument.uri, text)
    return
  }

  if (method === 'textDocument/didClose') {
    const uri = msg.params.textDocument.uri
    sendToTsServer(msg)
    clearTimeout(lintDebounce.get(uri))
    lintDebounce.delete(uri)
    diagMap.delete(uri)
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
