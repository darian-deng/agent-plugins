#!/usr/bin/env node
// PostToolUse hook: runs ESLint on Write/Edit target file, outputs errors to stdout
// so Claude sees them in the same turn and can fix immediately.

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

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

async function main() {
  // Claude Code passes the tool result file path as first argument
  const toolResultFile = process.argv[2]
  if (!toolResultFile) process.exit(0)

  let toolResult
  try {
    const raw = await readFile(toolResultFile, 'utf8')
    toolResult = JSON.parse(raw)
  } catch {
    process.exit(0)
  }

  // Extract file path from tool input
  const filePath = toolResult?.tool_input?.file_path
  if (!filePath) process.exit(0)

  // Only lint TS/JS files
  if (!/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(filePath)) process.exit(0)
  if (!existsSync(filePath)) process.exit(0)

  const pkgRoot = findPkgRoot(filePath)
  if (!pkgRoot) process.exit(0)

  const req = createRequire(resolve(pkgRoot, 'package.json'))
  let ESLint
  try {
    ;({ ESLint } = req('eslint'))
  } catch {
    process.exit(0)
  }

  const major = parseInt(req('eslint/package.json').version, 10)
  const overrides = major >= 10
    ? [{ languageOptions: { parserOptions: { project: false } } }]
    : []

  const eslint = new ESLint({ cwd: pkgRoot, overrideConfig: overrides })

  let results
  try {
    const src = await readFile(filePath, 'utf8')
    results = await eslint.lintText(src, { filePath })
  } catch (err) {
    process.stdout.write(`ESLint error: ${err?.message ?? String(err)}\n`)
    process.exit(0)
  }

  const messages = results[0]?.messages ?? []
  if (messages.length === 0) process.exit(0)

  const errors = messages.filter(m => m.severity === 2)
  const warnings = messages.filter(m => m.severity === 1)

  const lines = [`ESLint found ${messages.length} issue(s) in ${filePath}:`]
  for (const m of messages) {
    const sev = m.severity === 2 ? 'error' : 'warning'
    const loc = `${m.line ?? 1}:${m.column ?? 1}`
    const rule = m.ruleId ? ` [${m.ruleId}]` : ''
    lines.push(`  ${sev} ${loc}  ${m.message}${rule}`)
  }
  if (errors.length > 0) {
    lines.push(`Please fix ${errors.length} error(s) before finishing.`)
  }

  process.stdout.write(lines.join('\n') + '\n')
}

main().catch(() => process.exit(0))
