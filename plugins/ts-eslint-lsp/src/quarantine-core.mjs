// Shared quarantine bookkeeping for the "subagent is actively writing files" window.
//
// WHY THIS EXISTS
// A subagent edits files on DISK in its own context; those writes never reach this LSP connection as
// `didChange`. tsserver's own polling watcher then catches the subagent's step-by-step saves at an
// INTERMEDIATE, self-inconsistent moment and publishes phantom diagnostics against code that is
// correct on disk. The old design tried to REPAIR those diagnostics AFTER the subagent returned —
// but Claude Code collects its diagnostic snapshot synchronously (~37-379ms after return) while any
// async refresh needs ~1s, so the snapshot always lost the race.
//
// The fix flips the timing: a `PreToolUse:Agent` hook marks quarantine at DISPATCH (before any write
// happens), and a `SubagentStop` hook clears it at real completion. While quarantine is active, the
// proxy downgrades TS diagnostics on files the session never opened (never-opened ⇒ disk is the only
// truth, and disk is mid-write ⇒ untrustworthy) from Error to Hint, so a phantom can no longer wear
// a "real error" shape. Because quarantine is set BEFORE the write window, it has no race with the
// return snapshot — it is deterministic, not a probability game.
//
// COUNTING MODEL
// One marker file per in-flight subagent (PreToolUse:Agent adds; SubagentStop removes one, deduped by
// transcript so a repeat stop can't over-remove — see claimStop). Quarantine is active while ≥1 marker
// exists. Counting is lock-free (each marker is its own file). Empirically (2026-07-10) the two ends do
// NOT balance perfectly: a normal subagent fires PRE→SubagentStop→POST 1:1, but a DENIED Agent call
// fires PreToolUse only (no SubagentStop, no PostToolUse) — that marker leaks and is reaped by the
// stale sweep (STALE_MS below). A leak is always the over-quarantine / SAFE direction (a real
// diagnostic shows as Information a bit longer, tsc still the terminal judge); the UNSAFE direction
// (removing a live subagent's marker via a duplicate stop) is what claimStop prevents.
//
// SCOPING
// Markers are global (~/.claude), shared by every window. A marker records the subagent's cwd so a
// proxy only quarantines for markers whose project relates to its own root — otherwise an unrelated
// window's subagent would needlessly downgrade real diagnostics in a project you're actively editing.
import { openSync, closeSync, writeSync, mkdirSync, readdirSync, rmSync, statSync, readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const QUARANTINE_DIR = join(homedir(), '.claude', 'ts-eslint-lsp.quarantine.d')
// Bumped on every add/remove so a proxy watching it re-evaluates state near-instantly.
export const QUARANTINE_SIGNAL = join(homedir(), '.claude', 'ts-eslint-lsp.quarantine')
// Records which subagent transcripts have already had their SubagentStop processed. SubagentStop can
// fire MORE THAN ONCE for one subagent (Claude Code: "the same task-id may notify more than once"),
// and a naive per-stop decrement would then remove a SECOND, still-live subagent's marker → premature
// lift → phantom leak (the UNSAFE direction). Deduping by transcript path makes removal exactly-once
// per subagent. (Empirically confirmed 2026-07-10: the happy path fires PRE→SubagentStop→POST 1:1
// with a unique agent_transcript_path; a denied Agent call fires PreToolUse but NEITHER SubagentStop
// NOR PostToolUse — hence markers can only leak in the over-quarantine/safe direction, reaped by the
// stale sweep below.)
export const SEEN_DIR = join(homedir(), '.claude', 'ts-eslint-lsp.quarantine.seen.d')
// A marker older than this ⇒ assume its subagent died without a SubagentStop (e.g. the Agent call was
// permission-denied or errored before it ran, so PreToolUse:Agent added a marker that nothing removes).
// This is the ONLY leak-recovery path, so it bounds how long a leaked marker over-quarantines the
// session. It CANNOT go much lower: a marker must outlive the whole subagent run or a still-writing
// long subagent would have its quarantine lifted early (unsafe). agent-refresh-hook documents real TDD
// implementation runs of 10-15min, so 20min is the floor that both survives legitimate long runs and
// caps a leaked marker's blast radius. (CR B1/C: over-quarantine is the safe direction; tsc backstops.)
// NOTE: the sweep only reaps a marker when readMarkers() is called; the proxy's quarantine heartbeat
// (HEARTBEAT_MS) drives that call on a timer while quarantined, so this bound is actually enforced even
// when a leak leaves no further hook activity to trigger it. Without that heartbeat this would be a
// dead promise (CR round-2 §5).
const STALE_MS = 20 * 60 * 1000

function ensureDir() { try { mkdirSync(QUARANTINE_DIR, { recursive: true }) } catch {} }
function ensureSeenDir() { try { mkdirSync(SEEN_DIR, { recursive: true }) } catch {} }

function bumpSignal() {
  try { closeSync(openSync(QUARANTINE_SIGNAL, 'w')); const n = new Date(); utimesSync(QUARANTINE_SIGNAL, n, n) } catch {}
}

// Two paths P and Q are "related" when one contains the other (same file tree). Used both to scope a
// proxy to its project and to match a finishing subagent's cwd against the marker it created.
export function related(a, b) {
  if (!a || !b) return false
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/')
}

function sweepStale() {
  const now = Date.now()
  let entries
  try { entries = readdirSync(QUARANTINE_DIR) } catch { return }
  for (const e of entries) {
    try { if (now - statSync(join(QUARANTINE_DIR, e)).mtimeMs > STALE_MS) rmSync(join(QUARANTINE_DIR, e)) } catch {}
  }
}

// Read every live marker as { name, cwd, mtimeMs }. Skips unreadable/half-written entries.
function readMarkers() {
  ensureDir()
  sweepStale()
  const out = []
  let entries
  try { entries = readdirSync(QUARANTINE_DIR) } catch { return out }
  for (const name of entries) {
    const p = join(QUARANTINE_DIR, name)
    try {
      const mtimeMs = statSync(p).mtimeMs
      const cwd = readFileSync(p, 'utf8').trim()
      out.push({ name, cwd, mtimeMs })
    } catch { /* mid-write or vanished — ignore this poll */ }
  }
  return out
}

// PreToolUse:Agent — a subagent was just dispatched (before it has touched anything). Record a marker
// whose CONTENT is the subagent's cwd (used by the proxy to scope quarantine to the right project).
export function addMarker(cwd) {
  ensureDir()
  const unique = `${process.pid}-${Date.now()}-${process.hrtime.bigint().toString(36)}`
  try {
    const fd = openSync(join(QUARANTINE_DIR, unique), 'w')
    try { writeSync(fd, cwd ?? '') } finally { closeSync(fd) }
  } catch {}
  bumpSignal()
}

// SubagentStop — a subagent finished. Remove ONE marker for the related project (oldest first).
export function removeOneMarker(cwd) {
  const markers = readMarkers().filter((m) => related(m.cwd, cwd))
  if (markers.length) {
    markers.sort((a, b) => a.mtimeMs - b.mtimeMs)
    try { rmSync(join(QUARANTINE_DIR, markers[0].name)) } catch {}
  }
  bumpSignal()
}

// Proxy — how many in-flight subagents relate to this project root right now.
export function countActive(root) {
  return readMarkers().filter((m) => related(m.cwd, root)).length
}

// SubagentStop dedup: returns true the FIRST time a given transcript is seen (caller should remove a
// marker), false on any repeat (caller should skip). Atomic via O_EXCL create. A missing transcript id
// can't be deduped, so we return false (skip the removal) — the SAFE direction: at worst that subagent's
// marker leaks and is reaped by the stale sweep (over-quarantine), never a premature removal of a live
// subagent's marker (under-count → premature lift → phantom leak, the UNSAFE direction). A missing
// transcript is rare in practice (the SubagentStop payload carries agent_transcript_path — empirically
// present and unique per subagent), so this costs essentially nothing.
export function claimStop(transcriptPath) {
  if (!transcriptPath) return false
  ensureSeenDir()
  sweepSeen()
  const name = String(transcriptPath).replace(/[^A-Za-z0-9_.-]/g, '_')
  try { closeSync(openSync(join(SEEN_DIR, name), 'wx')); return true } // created ⇒ first time
  catch { return false }                                              // exists ⇒ duplicate stop
}

function sweepSeen() {
  const now = Date.now()
  let entries
  try { entries = readdirSync(SEEN_DIR) } catch { return }
  for (const e of entries) {
    try { if (now - statSync(join(SEEN_DIR, e)).mtimeMs > STALE_MS) rmSync(join(SEEN_DIR, e)) } catch {}
  }
}
