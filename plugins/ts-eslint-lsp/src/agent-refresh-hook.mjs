#!/usr/bin/env node
// PostToolUse hook for the `Agent` tool — fires in the MAIN agent's context when a subagent returns.
//
// A subagent edits files on DISK in its own context; those writes never reach this LSP connection as
// `didChange`, so tls keeps a stale program and emits phantom diagnostics (cannot-find-module /
// does-not-exist / implicit-any) against code that is correct on disk. We do two things:
//   1) Touch the proxy's refresh signal → proxy issues `_typescript.reloadProjects` (re-reads disk).
//      This fixes PROGRAM-level staleness — files the session never opened — the common case.
//   2) Inject `additionalContext` so the MAIN agent knows the RESIDUAL reloadProjects cannot fix:
//      a file already OPEN in this session is an editor-owned buffer that, by LSP design, overrides
//      disk — a subagent's on-disk edit to it stays invisible until didChange/didClose. For those,
//      trust typecheck over the IDE diagnostic.
//
// Gated on actually-changed .ts (mtime, commit-proof) so read-only subagents produce no reload/noise.
import { readFileSync, openSync, closeSync, utimesSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const WINDOW_MS = 300_000 // a file counts as "the subagent's" if written within the last 5 min
const SIGNAL = join(homedir(), '.claude', 'ts-eslint-lsp.refresh')
const PRUNE = new Set(['node_modules', '.git', 'dist', 'dist-local', 'build', 'coverage', '.next', 'out', '.turbo'])
const TS_RE = /\.(ts|tsx|mts|cts)$/

let raw = ''
try { raw = readFileSync(0, 'utf8') } catch {}
let cwd = process.cwd()
try { const j = JSON.parse(raw); if (j && typeof j.cwd === 'string') cwd = j.cwd } catch {}

const cutoff = Date.now() - WINDOW_MS
const changed = []
let budget = 40000 // bound the walk so a giant monorepo can't hang the hook
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
      try { if (statSync(p).mtimeMs >= cutoff) changed.push(p) } catch {}
    }
  }
}
walk(cwd)

if (changed.length === 0) process.exit(0) // read-only subagent / no recent TS write → nothing to do

// (1) Trigger the proxy's reloadProjects (atomic-ish: create-or-truncate then bump mtime).
try { closeSync(openSync(SIGNAL, 'w')); const now = new Date(); utimesSync(SIGNAL, now, now) } catch {}

// (2) Remind the MAIN agent about the open-buffer residual reloadProjects cannot fix.
const rel = changed.slice(0, 5).map(f => (f.startsWith(cwd + '/') ? f.slice(cwd.length + 1) : f))
const more = changed.length > 5 ? ` (+${changed.length - 5} more)` : ''
const msg =
  `ts-eslint-lsp: a subagent changed ${changed.length} TypeScript file(s) on disk (${rel.join(', ')}${more}). ` +
  `The TypeScript project was auto-refreshed (reloadProjects), so diagnostics on files NOT open in this ` +
  `session are now accurate. Residual: if one of these files was ALREADY open in this session, its IDE ` +
  `diagnostics may be a stale editor buffer the refresh cannot override — when a diagnostic on these ` +
  `files contradicts a clean tsc/typecheck, re-read the file or trust typecheck before acting.`
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg } }))
