#!/usr/bin/env node
// PostToolUse hook: Claude Code passes JSON via stdin with tool_input/tool_response.
// Runs ESLint on the written file and outputs errors to stdout for same-turn fix.

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { get } from 'node:http'
import { homedir } from 'node:os'

// aggregator 监听成功后把 {ideName, pid, port} 写入此发现文件。hook 读它拿端口（而非在 hook 这边
// 重复硬编码端口——由 aggregator 如实上报，单一真相来源），并用 ideName + pid 验活确认对面确实是
// 存活的 aggregator，避免误连占用同端口的无关程序。
const DISCOVERY_FILE = join(homedir(), '.claude', 'ts-eslint-lsp.json')

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
  // 早期实现去 ~/.claude/ide/*.lock 找一张 aggregator 从不写的「名片」，于是恒返回 null、每次都退化到
  // 慢路径 lintDirect，预热服务形同虚设。改为读 aggregator 实际写的发现文件：校验 ideName + pid 存活
  // （避免误连占用同端口的无关程序），返回它如实上报的端口。任一校验不过 → null 走直跑慢路径。
  try {
    const info = JSON.parse(readFileSync(DISCOVERY_FILE, 'utf8'))
    if (info.ideName !== 'eslint-aggregator' || !info.port) return null
    // Verify process is alive before waiting 10s on a dead socket
    try { process.kill(info.pid, 0) } catch { return null }
    return info.port
  } catch {
    return null
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    // agent:false → 不走 keep-alive。这个 hook 是一次性进程：发一个请求、拿到结果就该立刻退出。
    // Node 19+ 默认 http.globalAgent.keepAlive=true，池化的连接会滞留；更要命的是下面 204 分支
    // resolve 时不消费响应体，未 drain 的响应流会一直 ref 住 socket，直到服务端 keepAliveTimeout
    // （默认 5s）才关——于是每次「无报错」的 hook（最常见路径）都白等 ~5s。agent:false 让连接随请求关闭。
    const req = get(url, { agent: false }, (res) => {
      // 即使忽略响应体（204 = 无问题）也要 drain：未消费的响应流会吊住 socket、阻止进程退出。
      if (res.statusCode === 204) { res.resume(); resolve(''); return }
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')) })
  })
}

async function lintViaAggregator(filePath) {
  const port = getAggregatorPort()
  if (!port) return null
  try {
    const uri = 'file://' + filePath
    return await httpGet(`http://127.0.0.1:${port}/lint?uri=${encodeURIComponent(uri)}`)
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

async function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => { data += chunk })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(''))
  })
}

async function main() {
  const raw = await readStdin()
  if (!raw.trim()) return

  let payload
  try { payload = JSON.parse(raw) } catch { return }

  // Claude Code sends: {session_id, tool_name, tool_input, tool_response}
  const filePath = payload?.tool_input?.file_path
  if (!filePath) return
  if (!/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(filePath)) return
  if (!existsSync(filePath)) return

  // Fast path: aggregator (~50ms warm)
  let output = await lintViaAggregator(filePath)

  // Slow path: direct ESLint (~1s)
  if (output === null) output = await lintDirect(filePath)

  if (!output) {
    // Explicitly confirm ESLint passed so Claude doesn't try to verify via Bash.
    process.stdout.write(JSON.stringify({ additionalContext: 'ESLint: no issues found.' }))
    return
  }

  // PostToolUse requires JSON with additionalContext for Claude to see it.
  // Plain text stdout goes to debug log only.
  // decision:"block" prevents Claude from finishing until errors are fixed.
  const json = JSON.stringify({
    decision: 'block',
    reason: output.trimEnd(),
  })
  process.stdout.write(json)
}

main().catch(() => {})
