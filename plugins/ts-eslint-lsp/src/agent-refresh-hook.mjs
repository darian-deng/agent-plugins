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
//
// Cutoff is anchored to THIS dispatch's own wall-clock duration (tool_response.totalDurationMs),
// not a fixed lookback window — a fixed window silently misses files edited early in a long subagent
// run (measured in production: TDD implementation runs regularly exceed 10-15min, so a 5min window
// dropped reload entirely for the earliest-touched files — schema/types, the ones most likely to
// cause downstream phantom diagnostics — with zero warning that it had done so).
//
// Background dispatches (an omitted `run_in_background` defaults to background as of Claude Code
// v2.1.198) fire this hook at LAUNCH, before the subagent has touched anything, with no duration
// field — walking now would find nothing relevant. subagentstop-refresh-hook.mjs is the backstop
// that catches those at their real completion; this hook exits immediately for that case.
import { readFileSync } from 'node:fs'
import { findChangedSince, triggerReload } from './refresh-core.mjs'

const WINDOW_MS = 300_000 // fallback only — foreground dispatches always carry totalDurationMs

let raw = ''
try { raw = readFileSync(0, 'utf8') } catch {}
let cwd = process.cwd()
let durationMs = null
let isBackground = false
try {
  const j = JSON.parse(raw)
  if (j && typeof j.cwd === 'string') cwd = j.cwd
  const tr = j && j.tool_response
  if (tr && tr.status === 'async_launched') isBackground = true
  if (tr && typeof tr.totalDurationMs === 'number') durationMs = tr.totalDurationMs
} catch {}

if (isBackground) process.exit(0) // subagentstop-refresh-hook.mjs handles real completion

const DISPATCH_OVERHEAD_MS = 30_000 // slack before the subagent's first edit
const cutoff = Date.now() - (durationMs != null ? durationMs + DISPATCH_OVERHEAD_MS : WINDOW_MS)

const changed = findChangedSince(cwd, cutoff)
if (changed.length === 0) process.exit(0) // read-only subagent / no recent TS write → nothing to do

triggerReload()

// Remind the MAIN agent about the open-buffer residual reloadProjects cannot fix.
const rel = changed.slice(0, 5).map(f => (f.startsWith(cwd + '/') ? f.slice(cwd.length + 1) : f))
const more = changed.length > 5 ? ` (+${changed.length - 5} more)` : ''
const msg =
  `ts-eslint-lsp: a subagent changed ${changed.length} TypeScript file(s) on disk (${rel.join(', ')}${more}). ` +
  `The TypeScript project was auto-refreshed (reloadProjects), so diagnostics on files NOT open in this ` +
  `session are now accurate. Residual: if one of these files was ALREADY open in this session, its IDE ` +
  `diagnostics may be a stale editor buffer the refresh cannot override — when a diagnostic on these ` +
  `files contradicts a clean tsc/typecheck, re-read the file or trust typecheck before acting.`
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg } }))
