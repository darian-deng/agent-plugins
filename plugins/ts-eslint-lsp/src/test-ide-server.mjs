#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverPath = join(__dirname, 'eslint-ide-server.mjs')
const testUri = process.argv[2] ?? 'file:///Users/plaud/Documents/Codes/worktrees/fe-nexus2/apps/plaud-desktop/src/renderer/src/utils/arrayUtils.ts'

const server = spawn('node', [serverPath], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ESLINT_IDE_PORT: '7476' } })
let port = null
server.stdout.on('data', (d) => { const m = d.toString().match(/ESLINT_IDE_PORT=(\d+)/); if (m) port = parseInt(m[1]) })
server.stderr.on('data', (d) => process.stderr.write(d))

await new Promise(r => setTimeout(r, 400))
if (!port) { console.error('Server did not start'); process.exit(1) }
console.log(`Server on port ${port}`)

const sseRes = await fetch(`http://127.0.0.1:${port}/sse`, { headers: { Accept: 'text/event-stream' } })
const reader = sseRes.body.getReader()
const dec = new TextDecoder()

let buf = '', endpoint = null
while (!endpoint) {
  const { value } = await reader.read()
  buf += dec.decode(value)
  const m = buf.match(/data: (http:\/\/\S+)/)
  if (m) { endpoint = m[1]; break }
}
console.log('Endpoint:', endpoint)

let _id = 1
const pending = new Map()
const listenLoop = async () => {
  let b = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    b += dec.decode(value)
    const lines = b.split('\n')
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try { const d = JSON.parse(line.slice(6)); if (d.id != null && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) } } catch {}
      }
    }
    b = lines[lines.length - 1]
  }
}
listenLoop()

async function rpc(method, params) {
  const id = _id++
  const p = new Promise(resolve => pending.set(id, resolve))
  await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
  return p
}

const init = await rpc('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '1' }, capabilities: {} })
console.log('Server info:', init.result?.serverInfo)

const tools = await rpc('tools/list', {})
console.log('Tools:', tools.result?.tools?.map(t => t.name))

console.log('\n--- getDiagnostics (with uri) ---')
const r1 = await rpc('tools/call', { name: 'getDiagnostics', arguments: { uri: testUri } })
const parsed1 = JSON.parse(r1.result?.content?.[0]?.text ?? '[]')
for (const f of parsed1) {
  console.log(`${f.uri.split('/').pop()}: ${f.diagnostics.length} diagnostic(s)`)
  for (const d of f.diagnostics.slice(0, 5)) {
    console.log(`  [${d.severity === 1 ? 'error' : 'warn'}] L${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}`)
  }
}

console.log('\n--- getDiagnostics (no uri = getNewDiagnostics path) ---')
const r2 = await rpc('tools/call', { name: 'getDiagnostics', arguments: {} })
const parsed2 = JSON.parse(r2.result?.content?.[0]?.text ?? '[]')
console.log('Files returned:', parsed2.length)

server.kill()
process.exit(0)
