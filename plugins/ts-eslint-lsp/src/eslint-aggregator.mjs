#!/usr/bin/env node

import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, statSync, writeFileSync, unlinkSync, readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'

// Fixed port. Binding it IS the singleton lock: the OS lets exactly one process hold a TCP port and
// releases it automatically on process death — atomic, race-free, no stale-lock problem. We do NOT
// auto-bump to another port on conflict: that would let two instances live on different ports and
// reintroduce the very concurrency/stale-lock races a file lock would need (and can't cleanly win).
// 7475 sits below the ephemeral range (macOS 49152+, Linux 32768+) so it's never grabbed as a random
// outbound port, and isn't a common app default. Override via ESLINT_IDE_PORT if it ever collides.
const PORT = parseInt(process.env.ESLINT_IDE_PORT ?? '7475', 10)
const PROJECT_ROOT = process.env.ESLINT_PROJECT_ROOT ?? process.cwd()

const PID_FILE = join(homedir(), '.claude', 'ts-eslint-lsp.pid')
// Discovery file: lets the PostToolUse hook learn the ACTUAL listening port and confirm identity,
// instead of hardcoding a port. Kept separate from PID_FILE (which stays a bare pid string so the
// SessionStart shell check `cat`/`ps` keeps working unchanged).
const DISCOVERY_FILE = join(homedir(), '.claude', 'ts-eslint-lsp.json')
const IDE_NAME = 'eslint-aggregator'

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
  // Only remove the PID file if it is OURS. A second instance that exits (port taken, or yielding
  // to a live instance) never called writePid(), so the file still holds the FIRST (live)
  // instance's pid — unconditionally unlinking it would delete a live instance's PID file and
  // corrupt the SessionStart "is it running?" check. Guard by content equality.
  try {
    if (readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(PID_FILE)
  } catch { /* gone */ }
}

// The discovery file is NOT a lock (the port is — see PORT above); it just publishes our identity
// and port so the hook can find us. Written once we've bound the port (i.e. once we're the singleton).
function writeDiscovery(port) {
  writeFileSync(DISCOVERY_FILE, JSON.stringify({ ideName: IDE_NAME, pid: process.pid, port }))
}

function removeDiscovery() {
  // Ownership guard: only unlink if the discovery file is ours. A second instance that exits on
  // EADDRINUSE never wrote it, so the file still holds the live owner's pid — don't delete it.
  try {
    if (JSON.parse(readFileSync(DISCOVERY_FILE, 'utf8')).pid === process.pid) unlinkSync(DISCOVERY_FILE)
  } catch { /* gone or not ours */ }
}

process.on('exit', () => { removePid(); removeDiscovery() })
process.on('SIGTERM', () => { removePid(); removeDiscovery(); process.exit(0) })
process.on('SIGINT', () => { removePid(); removeDiscovery(); process.exit(0) })
process.on('uncaughtException', (err) => process.stderr.write(`eslint-aggregator: uncaught — ${err.message}\n`))
process.on('unhandledRejection', (reason) => process.stderr.write(`eslint-aggregator: unhandledRejection — ${reason}\n`))

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost') // base host only; req.url is a path, port irrelevant

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
  // EADDRINUSE = someone already holds PORT — either our own already-running instance (singleton
  // enforced by the OS) or a foreign program. Either way, yield: exit and let the hook fall back to
  // lintDirect. No port bump — a fixed port is the lock, deliberately (see PORT).
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(`eslint-aggregator: port ${PORT} already in use, yielding\n`)
    process.exit(0)
  }
  process.stderr.write(`eslint-aggregator: server error — ${err.message}\n`)
  process.exit(0)
})

server.on('listening', () => {
  // We hold the port (the singleton lock). Publish discovery (before prewarm) so the hook finds us ASAP.
  writeDiscovery(PORT)
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

// Bind the fixed port. Success = we are the singleton owner; conflict → 'error' handler yields.
server.listen(PORT, '127.0.0.1')
