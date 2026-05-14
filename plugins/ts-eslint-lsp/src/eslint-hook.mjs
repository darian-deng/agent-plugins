#!/usr/bin/env node
// PostToolUse hook: lint the written file, output errors to stdout for same-turn fix.
// Fast path (~50ms): delegates to running aggregator's /lint endpoint.
// Slow path (~1s): spawns ESLint directly.

import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { get } from 'node:http'
import { homedir } from 'node:os'

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
  try {
    const lockDir = join(homedir(), '.claude', 'ide')
    const files = readdirSync(lockDir).filter(f => f.endsWith('.lock'))
    for (const f of files) {
      try {
        const lock = JSON.parse(readFileSync(join(lockDir, f), 'utf8'))
        if (lock.ideName === 'eslint-aggregator') return parseInt(f)
      } catch {}
    }
  } catch {}
  return null
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = get(url, (res) => {
      if (res.statusCode === 204) { resolve(''); return }
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.setTimeout(3000, () => { req.destroy(new Error('timeout')) })
  })
}

async function lintViaAggregator(filePath) {
  const port = getAggregatorPort()
  if (!port) return null
  try {
    const uri = 'file://' + filePath
    const result = await httpGet(`http://127.0.0.1:${port}/lint?uri=${encodeURIComponent(uri)}`)
    return result  // '' means no errors (204), string means errors
  } catch {
    return null
  }
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
  if (!toolResultFile) return

  let toolResult
  try {
    const raw = await readFile(toolResultFile, 'utf8')
    toolResult = JSON.parse(raw)
  } catch { return }

  const filePath = toolResult?.tool_input?.file_path
  if (!filePath) return
  if (!/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(filePath)) return
  if (!existsSync(filePath)) return

  // Fast path: aggregator (warm ESLint ~50ms)
  let output = await lintViaAggregator(filePath)

  // Slow path: direct ESLint (~1s cold)
  if (output === null) output = await lintDirect(filePath)

  if (output) process.stdout.write(output)
}

main().catch(() => {})
