#!/usr/bin/env node
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, watch } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const PORT = parseInt(process.env.ESLINT_IDE_PORT ?? '7475', 10) || 7475

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
  if (!configWatchers.has(pkgRoot)) {
    const watchers = []
    for (const name of FLAT_CONFIGS) {
      const p = resolve(pkgRoot, name)
      if (!existsSync(p)) continue
      try {
        watchers.push(watch(p, { persistent: false }, () => {
          eslintCache.delete(pkgRoot)
          configWatchers.delete(pkgRoot)
        }))
      } catch { /* disappeared */ }
    }
    if (watchers.length) configWatchers.set(pkgRoot, watchers)
  }
  return { instance, major }
}

async function runLint(uri) {
  const filePath = uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri
  if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) return { uri, diagnostics: [] }
  const pkgRoot = findPkgRoot(filePath)
  if (!pkgRoot) return { uri, diagnostics: [] }
  const cached = getESLint(pkgRoot)
  if (!cached) return { uri, diagnostics: [] }
  const { instance: eslint, major } = cached
  let text
  try {
    const { readFile } = await import('node:fs/promises')
    text = await readFile(filePath, 'utf8')
  } catch {
    return { uri, diagnostics: [] }
  }
  let results
  try {
    results = await eslint.lintText(text, { filePath })
  } catch (err) {
    const msg = err?.message ?? String(err)
    const isScopeError = /addGlobals|scopeManager/i.test(msg)
    return {
      uri,
      diagnostics: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: 2,
        source: 'eslint-lsp',
        code: 'eslint-lsp/config-error',
        message: isScopeError
          ? `eslint-lsp: ESLint v${major} scope manager error — ${msg}`
          : `eslint-lsp: ESLint failed to lint this file — ${msg}`,
      }],
    }
  }
  const messages = results[0]?.messages ?? []
  return {
    uri,
    diagnostics: messages.map((m) => ({
      range: {
        start: { line: Math.max(0, (m.line ?? 1) - 1), character: Math.max(0, (m.column ?? 1) - 1) },
        end: { line: Math.max(0, (m.endLine ?? m.line ?? 1) - 1), character: Math.max(0, (m.endColumn ?? m.column ?? 1) - 1) },
      },
      severity: m.severity === 2 ? 1 : 2,
      source: 'eslint',
      code: m.ruleId ?? undefined,
      message: m.ruleId ? `${m.message}  [${m.ruleId}]` : m.message,
    })),
  }
}

const sseClients = new Map()

async function handleJsonRpc(msg, sessionId) {
  const { id, method, params } = msg

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'eslint-ide-mcp', version: '0.1.0' },
      },
    }
  }

  if (method === 'notifications/initialized') return null

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0', id,
      result: {
        tools: [{
          name: 'getDiagnostics',
          description: 'Get ESLint diagnostics for a file',
          inputSchema: {
            type: 'object',
            properties: {
              uri: { type: 'string', description: 'file:// URI of the file to lint' },
            },
            required: ['uri'],
          },
        }],
      },
    }
  }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params ?? {}
    if (name !== 'getDiagnostics') {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool' } }
    }
    try {
      let results
      if (args.uri) {
        results = [await runLint(args.uri)]
      } else {
        results = []
      }
      return {
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(results) }],
        },
      }
    } catch (err) {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: String(err) } }
    }
  }

  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }

  if (id != null) return { jsonrpc: '2.0', id, result: null }
  return null
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/sse') {
    const clientId = randomUUID()
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    sseClients.set(clientId, res)
    const endpoint = `http://127.0.0.1:${server.address().port}/message?sessionId=${clientId}`
    res.write(`event: endpoint\ndata: ${endpoint}\n\n`)
    req.on('close', () => sseClients.delete(clientId))
    return
  }

  if (req.method === 'POST' && req.url?.startsWith('/message')) {
    const url = new URL(req.url, 'http://x')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end('{}')
      let msg
      try { msg = JSON.parse(body) } catch { return }
      try {
        const reply = await handleJsonRpc(msg, sessionId)
        if (reply) {
          const client = sseClients.get(sessionId)
          if (client) client.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`)
        }
      } catch (err) {
        const client = sseClients.get(sessionId)
        if (client && msg?.id != null) {
          const errReply = { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(err) } }
          client.write(`event: message\ndata: ${JSON.stringify(errReply)}\n\n`)
        }
      }
    })
    return
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'content-type' })
    res.end()
    return
  }

  res.writeHead(404)
  res.end()
})

server.listen(PORT, '127.0.0.1', () => {
  const { port } = server.address()
  process.stdout.write(`ESLINT_IDE_PORT=${port}\n`)
})

server.on('error', (err) => {
  process.stderr.write(`eslint-ide-server error: ${err.message}\n`)
  process.exit(1)
})

process.on('SIGTERM', () => server.close(() => process.exit(0)))
process.on('SIGINT', () => server.close(() => process.exit(0)))
