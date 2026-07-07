// Shared logic for detecting subagent-changed .ts files and signaling the
// proxy to reload. Used by both agent-refresh-hook.mjs (PostToolUse:Agent,
// foreground dispatches) and subagentstop-refresh-hook.mjs (SubagentStop,
// backstop for background dispatches).
import { openSync, closeSync, utimesSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const SIGNAL = join(homedir(), '.claude', 'ts-eslint-lsp.refresh')
const PRUNE = new Set(['node_modules', '.git', 'dist', 'dist-local', 'build', 'coverage', '.next', 'out', '.turbo'])
const TS_RE = /\.(ts|tsx|mts|cts)$/

// Find .ts/.tsx/.mts/.cts files under `cwd` with mtime >= cutoffMs (epoch ms).
// Bounded walk (budget + result cap) so a giant monorepo can't hang the hook.
export function findChangedSince(cwd, cutoffMs) {
  const changed = []
  let budget = 40000
  function walk(dir) {
    if (budget <= 0 || changed.length >= 50) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (budget-- <= 0 || changed.length >= 50) return
      if (e.isDirectory()) {
        if (PRUNE.has(e.name) || e.name.startsWith('.')) continue
        walk(join(dir, e.name))
      } else if (e.isFile() && TS_RE.test(e.name)) {
        const p = join(dir, e.name)
        try { if (statSync(p).mtimeMs >= cutoffMs) changed.push(p) } catch {}
      }
    }
  }
  walk(cwd)
  return changed
}

// Touch the proxy's refresh signal (atomic-ish: create-or-truncate then bump mtime).
export function triggerReload() {
  try { closeSync(openSync(SIGNAL, 'w')); const now = new Date(); utimesSync(SIGNAL, now, now) } catch {}
}
