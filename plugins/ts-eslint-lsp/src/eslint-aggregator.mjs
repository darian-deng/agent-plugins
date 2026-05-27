#!/usr/bin/env node

import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, statSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'

const PORT = parseInt(process.env.ESLINT_IDE_PORT ?? '7475', 10)
const PROJECT_ROOT = process.env.ESLINT_PROJECT_ROOT ?? process.cwd()

const PID_FILE = join(homedir(), '.claude', 'ts-eslint-lsp.pid')

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
const configFingerprintCache = new Map()

function getConfigFingerprint(pkgRoot) {
  for (const name of FLAT_CONFIGS) {
    const p = resolve(pkgRoot, name)
    try {
      const s = statSync(p)
      return `${s.ino}:${s.mtimeMs}`
    } catch {}
  }
  return null
}

function getESLint(pkgRoot) {
  const fp = getConfigFingerprint(pkgRoot)
  if (eslintCache.has(pkgRoot) && configFingerprintCache.get(pkgRoot) === fp) {
    return eslintCache.get(pkgRoot)
  }

  // fingerprint changed (or first call) — rebuild instance
  eslintCache.delete(pkgRoot)
  configFingerprintCache.delete(pkgRoot)

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
  configFingerprintCache.set(pkgRoot, fp)
  eslintCache.set(pkgRoot, { instance, major })
  return { instance, major }
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

function writePid() {
  writeFileSync(PID_FILE, String(process.pid))
}

function removePid() {
  try { unlinkSync(PID_FILE) } catch { /* gone */ }
}

process.on('exit', removePid)
process.on('SIGTERM', () => { removePid(); process.exit(0) })
process.on('SIGINT', () => { removePid(); process.exit(0) })
process.on('uncaughtException', (err) => process.stderr.write(`eslint-aggregator: uncaught — ${err.message}\n`))
process.on('unhandledRejection', (reason) => process.stderr.write(`eslint-aggregator: unhandledRejection — ${reason}\n`))

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

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
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
  writePid()
  process.stderr.write(`eslint-aggregator: listening on port ${PORT}\n`)

  // Scan up to 3 levels deep for eslint.config.* — handles monorepos where the
  // config lives in a sub-package (e.g. apps/plaud-desktop/) rather than the root.
  const pkgRoot = findPkgRoot(resolve(PROJECT_ROOT, 'index.ts'))
    ?? findPkgRoot(resolve(PROJECT_ROOT, 'src', 'index.ts'))
    ?? (() => {
      const scan = (dir, depth) => {
        if (depth === 0) return null
        for (const name of FLAT_CONFIGS) {
          if (existsSync(`${dir}/${name}`)) return dir
        }
        try {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
            const found = scan(`${dir}/${e.name}`, depth - 1)
            if (found) return found
          }
        } catch {}
        return null
      }
      return scan(PROJECT_ROOT, 3)
    })()

  if (pkgRoot) {
    // Create and cache the ESLint instance eagerly so the first /lint call skips instance
    // creation (~100ms). Rule loading still happens on the first lintText call (~4s).
    getESLint(pkgRoot)
    process.stderr.write(`eslint-aggregator: prewarmed ESLint instance for ${pkgRoot}\n`)
  }
})
