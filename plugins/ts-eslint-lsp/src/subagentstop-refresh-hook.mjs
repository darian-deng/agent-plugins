#!/usr/bin/env node
// SubagentStop hook — backstop for background-dispatched Agent calls.
//
// PostToolUse:Agent fires at LAUNCH for background subagents (an omitted `run_in_background`
// defaults to background as of Claude Code v2.1.198), carrying no duration/usage fields — so it
// can't detect what a backgrounded subagent changed, or even that it's done yet. SubagentStop fires
// at the subagent's REAL completion regardless of dispatch mode, making it the only reliable place
// to catch that case.
//
// It can only trigger the reload signal, not inject context into the parent session — Claude Code
// routes that only through PostToolUse:Agent (see docs: "To inject context into the parent session
// after a subagent returns, use a PostToolUse hook on the Agent tool instead"). So the mid-refresh
// reminder stays a foreground-only feature; this hook silently keeps the TS program fresh.
//
// Runs for every subagent (foreground included) — harmless overlap with agent-refresh-hook.mjs,
// since triggerReload() is idempotent and the walk is cheap (measured: a few thousand directory
// entries on real repos, well under budget).
import { readFileSync } from 'node:fs'
import { findChangedSince, triggerReload } from './refresh-core.mjs'

const FALLBACK_WINDOW_MS = 1_800_000 // 30min — only if the subagent transcript is unreadable

let raw = ''
try { raw = readFileSync(0, 'utf8') } catch {}
let cwd = process.cwd()
let transcriptPath = null
try {
  const j = JSON.parse(raw)
  if (j && typeof j.cwd === 'string') cwd = j.cwd
  if (j && typeof j.agent_transcript_path === 'string') transcriptPath = j.agent_transcript_path
} catch {}

// Anchor the cutoff to the subagent's own dispatch start, read from its first transcript line's
// timestamp — more precise than any fixed window, and the only start-time signal available here.
let cutoff = Date.now() - FALLBACK_WINDOW_MS
try {
  const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean)
  for (const line of lines) {
    const rec = JSON.parse(line)
    if (rec && rec.timestamp) { cutoff = new Date(rec.timestamp).getTime(); break }
  }
} catch {}

const changed = findChangedSince(cwd, cutoff)
if (changed.length === 0) process.exit(0)
triggerReload()
