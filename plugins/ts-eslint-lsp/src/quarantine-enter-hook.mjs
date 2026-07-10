#!/usr/bin/env node
// PreToolUse:Agent hook — fires in the MAIN agent's context the moment a subagent is DISPATCHED,
// before it has written anything to disk. It records a quarantine marker so the proxy starts
// downgrading never-opened TS diagnostics for the whole time the subagent runs — closing the window
// deterministically rather than racing to repair it after the subagent returns (see quarantine-core).
//
// Fires for every Agent dispatch, foreground and background alike (PreToolUse always runs before the
// tool). A read-only subagent that writes nothing still opens a quarantine window; that is deliberate
// over-quarantine — the safe direction — and it is cleared by SubagentStop the same way. We enter
// unconditionally here because at dispatch time we cannot yet know whether the subagent will write.
import { readFileSync } from 'node:fs'
import { addMarker } from './quarantine-core.mjs'

let raw = ''
try { raw = readFileSync(0, 'utf8') } catch {}
let cwd = process.cwd()
try {
  const j = JSON.parse(raw)
  if (j && typeof j.cwd === 'string') cwd = j.cwd
} catch {}

addMarker(cwd)
