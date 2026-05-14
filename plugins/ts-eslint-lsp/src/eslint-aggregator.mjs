#!/usr/bin/env node

import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, watch, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

const PORT = parseInt(process.env.ESLINT_IDE_PORT ?? '7475', 10)
const AUTH_TOKEN = process.env.ESLINT_AUTH_TOKEN ?? randomBytes(32).toString('base64')
const PROJECT_ROOT = process.env.ESLINT_PROJECT_ROOT ?? process.cwd()

const LOCK_DIR = join(homedir(), '.claude', 'ide')
const LOCK_FILE = join(LOCK_DIR, `${PORT}.lock`)

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
        diagnosticsCache.clear()
      })
      watchers.push(w)
    } catch { /* file disappeared */ }
  }
  if (watchers.length) configWatchers.set(pkgRoot, watchers)
}

async function runLint(uri, text) {
  const filePath = uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri
  if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) return []

  const pkgRoot = findPkgRoot(filePath)
  if (!pkgRoot) return []

  const cached = getESLint(pkgRoot)
  if (!cached) return []

  const { instance: eslint, major } = cached
  const src = text ?? await readFile(filePath, 'utf8').catch(() => null)
  if (src == null) return []

  let results
  try {
    results = await eslint.lintText(src, { filePath })
  } catch (err) {
    const msg = err?.message ?? String(err)
    const isScopeError = /addGlobals|scopeManager/i.test(msg)
    return [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 2,
      source: 'eslint',
      code: 'eslint/config-error',
      message: isScopeError
        ? `ESLint v${major} scope manager error — ${msg}`
        : `ESLint failed — ${msg}`,
    }]
  }

  return (results[0]?.messages ?? []).map((m) => ({
    range: {
      start: { line: Math.max(0, (m.line ?? 1) - 1),    character: Math.max(0, (m.column ?? 1) - 1) },
      end:   { line: Math.max(0, (m.endLine ?? m.line ?? 1) - 1), character: Math.max(0, (m.endColumn ?? m.column ?? 1) - 1) },
    },
    severity: m.severity === 2 ? 1 : 2,
    source: 'eslint',
    code: m.ruleId ?? undefined,
    message: m.ruleId ? `${m.message}  [${m.ruleId}]` : m.message,
  }))
}

const diagnosticsCache = new Map()

async function getDiagnostics(uri) {
  if (uri) {
    const diags = await runLint(uri)
    diagnosticsCache.set(uri, diags)
    return [{ uri, diagnostics: diags }]
  }
  const result = []
  for (const [u, diags] of diagnosticsCache) {
    result.push({ uri: u, diagnostics: diags })
  }
  return result
}

function writeLock() {
  try { mkdirSync(LOCK_DIR, { recursive: true }) } catch { /* exists */ }
  const lock = {
    workspaceFolders: [homedir()],
    pid: process.pid,
    ideName: 'eslint-aggregator',
    transport: 'sse',
    authToken: AUTH_TOKEN,
    runningInWindows: false,
  }
  writeFileSync(LOCK_FILE, JSON.stringify(lock))
}

function removeLock() {
  try { unlinkSync(LOCK_FILE) } catch { /* gone */ }
}

process.on('exit', removeLock)
process.on('SIGTERM', () => { removeLock(); process.exit(0) })
process.on('SIGINT', () => { removeLock(); process.exit(0) })

const sseClients = new Map()

function sendSSE(res, data) {
  res.write(`event: message\ndata: ${JSON.stringify(data)}\n\n`)
}

function makeResponse(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function makeError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

async function handleRpcCall(msg, sessionId, res) {
  const { method, id, params } = msg

  if (method === 'notifications/initialized' || method === 'ping') {
    if (id != null) sendSSE(res, makeResponse(id, {}))
    return
  }

  if (method === 'initialize') {
    sendSSE(res, makeResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'eslint-aggregator', version: '1.0.0' },
    }))
    return
  }

  if (method === 'tools/list') {
    sendSSE(res, makeResponse(id, {
      tools: [
        {
          name: 'getDiagnostics',
          description: 'Get ESLint diagnostics for a file or all tracked files',
          inputSchema: {
            type: 'object',
            properties: { uri: { type: 'string', description: 'File URI (optional)' } },
          },
        },
        {
          name: 'openDiagnostic',
          description: 'Open a diagnostic (stub)',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'getOpenEditorFiles',
          description: 'Get open editor files (stub)',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }))
    return
  }

  if (method === 'tools/call') {
    const toolName = params?.name
    const args = params?.arguments ?? {}

    if (toolName === 'getDiagnostics') {
      try {
        const result = await getDiagnostics(args.uri)
        sendSSE(res, makeResponse(id, { content: [{ type: 'text', text: JSON.stringify(result) }] }))
      } catch (err) {
        sendSSE(res, makeError(id, -32603, err?.message ?? String(err)))
      }
      return
    }

    if (toolName === 'openDiagnostic') {
      sendSSE(res, makeResponse(id, { content: [{ type: 'text', text: 'null' }] }))
      return
    }

    if (toolName === 'getOpenEditorFiles') {
      sendSSE(res, makeResponse(id, { content: [{ type: 'text', text: '[]' }] }))
      return
    }

    sendSSE(res, makeError(id, -32601, `Unknown tool: ${toolName}`))
    return
  }

  if (id != null) {
    sendSSE(res, makeError(id, -32601, `Unknown method: ${method}`))
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const ts = new Date().toISOString()
  process.stderr.write(`[${ts}] ${req.method} ${url.pathname} auth=${req.headers['authorization']?.slice(0,20) ?? 'none'}\n`)

  if (req.method === 'GET' && url.pathname === '/sse') {
    const sessionId = randomBytes(8).toString('hex')

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })

    sseClients.set(sessionId, res)
    res.on('close', () => sseClients.delete(sessionId))

    res.write(`event: endpoint\ndata: http://localhost:${PORT}/message?sessionId=${sessionId}\n\n`)
    return
  }

  if (req.method === 'POST' && url.pathname === '/message') {
    const sessionId = url.searchParams.get('sessionId')
    const sseRes = sseClients.get(sessionId)

    if (!sseRes) {
      res.writeHead(400)
      res.end('No SSE session')
      return
    }

    res.writeHead(202)
    res.end()

    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let msg
      try { msg = JSON.parse(body) } catch { return }
      handleRpcCall(msg, sessionId, sseRes).catch((err) => {
        if (msg.id != null) {
          sendSSE(sseRes, makeError(msg.id, -32603, err?.message ?? String(err)))
        }
      })
    })
    return
  }

  // Hook endpoint: GET /lint?uri=file:///path/to/file — returns ESLint results as plain text
  if (req.method === 'GET' && url.pathname === '/lint') {
    const uri = url.searchParams.get('uri')
    if (!uri) { res.writeHead(400); res.end('Missing uri'); return }
    runLint(uri).then((diags) => {
      if (diags.length === 0) { res.writeHead(204); res.end(); return }
      const filePath = uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri
      const lines = [`ESLint found ${diags.length} issue(s) in ${filePath}:`]
      for (const d of diags) {
        const sev = d.severity === 1 ? 'error' : 'warning'
        const loc = `${(d.range.start.line ?? 0) + 1}:${(d.range.start.character ?? 0) + 1}`
        const rule = d.code ? ` [${d.code}]` : ''
        lines.push(`  ${sev} ${loc}  ${d.message}${rule}`)
      }
      const errors = diags.filter(d => d.severity === 1)
      if (errors.length > 0) lines.push(`Please fix ${errors.length} error(s) before finishing.`)
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(lines.join('\n') + '\n')
    }).catch((err) => {
      res.writeHead(500); res.end(err?.message ?? String(err))
    })
    return
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return
  }

  res.writeHead(404)
  res.end()
})

server.on('error', (err) => {
  process.stderr.write(`eslint-aggregator: server error — ${err.message}\n`)
  process.exit(0)
})

server.listen(PORT, '127.0.0.1', () => {
  writeLock()
  process.stderr.write(`eslint-aggregator: listening on port ${PORT}\n`)

  const pkgRoot = findPkgRoot(resolve(PROJECT_ROOT, 'index.ts'))
    ?? findPkgRoot(resolve(PROJECT_ROOT, 'src', 'index.ts'))
    ?? (() => {
      for (const name of FLAT_CONFIGS) {
        if (existsSync(resolve(PROJECT_ROOT, name))) return PROJECT_ROOT
      }
      return null
    })()

  if (pkgRoot) {
    getESLint(pkgRoot)
    process.stderr.write(`eslint-aggregator: prewarmed ESLint for ${pkgRoot}\n`)
  }
})
