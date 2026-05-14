#!/usr/bin/env node
// PostToolUse hook: lint the written file and output errors so Claude fixes in the same turn.
// Fast path: delegates to running aggregator (warm ESLint, ~50ms).
// Slow path: spawns ESLint directly if aggregator is not running (~500-2000ms).

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { get } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

function getAggregatorPort() {
  const lockDir = join(homedir(), '.claude', 'ide')
  // Find any .lock file matching our aggregator
  try {
    const { readdirSync, readFileSync } = await import('node:fs')
  } catch {}
  try {
    const fs = await import('node:fs')
    const files = fs.readdirSync(lockDir).filter(f => f.endsWith('.lock'))
    for (const f of files) {
      try {
        const lock = JSON.parse(fs.readFileSync(join(lockDir, f), 'utf8'))
        if (lock.ideName === 'eslint-aggregator') return lock.port ?? parseInt(f)
      } catch {}
    }
  } catch {}
  return null
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      if (res.statusCode === 204) { resolve(''); return }
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve(data))
    }).on('error', reject).setTimeout(3000, function() { this.destroy(new Error('timeout')) })
  })
}

async function lintViaAggregator(filePath) {
  // Read port from lockfile
  try {
    const { readdirSync, readFileSync } = (await import('node:fs'))
    const lockDir = join(homedir(), '.claude', 'ide')
    const files = readdirSync(lockDir).filter(f => f.endsWith('.lock'))
    for (const f of files) {
      try {
        const lock = JSON.parse(readFileSync(join(lockDir, f), 'utf8'))
        if (lock.ideName !== 'eslint-aggregator') continue
        const port = lock.port ?? parseInt(f)
        const uri = `file://${encodeURIComponent(filePath).replace(/%2F/g, '/')}`
        const result = await httpGet(`http://127.0.0.1:${port}/lint?uri=${encodeURIComponent('file://' + filePath)}`)
        return result
      } catch {}
    }
  } catch {}
  return null
}

async function lintDirect(filePath) {
  const pkgRoot = findPkgRoot(filePath)
  if (!pkgRoot) return null

  const req = createRequire(resolve(pkgRoot, 'package.json'))
  let ESLint
  try { ;({ ESLint } = req('eslint')) } catch { return null }

  const major = parseInt(req('eslint/package.json').version, 10)
  const overrides = major >= 10
    ? [{ languageOptions: { parserOptions: { project: false } } }]
    : []

  const eslint = new ESLint({ cwd: pkgRoot, overrideConfig: overrides })
  try {
    const src = await readFile(filePath, 'utf8')
    const results = await eslint.lintText(src, { filePath })
    const messages = results[0]?.messages ?? []
    if (messages.length === 0) return ''
    const lines = [`ESLint found ${messages.length} issue(s) in ${filePath}:`]
    for (const m of messages) {
      const sev = m.severity === 2 ? 'error' : 'warning'
      const rule = m.ruleId ? ` [${m.ruleId}]` : ''
      lines.push(`  ${sev} ${m.line ?? 1}:${m.column ?? 1}  ${m.message}${rule}`)
    }
    const errors = messages.filter(m => m.severity === 2)
    if (errors.length > 0) lines.push(`Please fix ${errors.length} error(s) before finishing.`)
    return lines.join('\n') + '\n'
  } catch (err) {
    return `ESLint error: ${err?.message ?? String(err)}\n`
  }
}

async function main() {
  const toolResultFile = process.argv[2]
  if (!toolResultFile) process.exit(0)

  let toolResult
  try {
    const raw = await readFile(toolResultFile, 'utf8')
    toolResult = JSON.parse(raw)
  } catch { process.exit(0) }

  const filePath = toolResult?.tool_input?.file_path
  if (!filePath) process.exit(0)
  if (!/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(filePath)) process.exit(0)
  if (!existsSync(filePath)) process.exit(0)

  // Fast path: aggregator (warm ESLint)
  let output = await lintViaAggregator(filePath)

  // Slow path: direct ESLint
  if (output === null) output = await lintDirect(filePath)

  if (output) process.stdout.write(output)
  process.exit(0)
}

main().catch(() => process.exit(0))
