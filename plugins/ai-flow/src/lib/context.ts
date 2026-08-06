import { existsSync, openSync, fstatSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface TokenUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// Bytes of transcript tail to read per attempt. The answer is normally within
// the last few lines, so this is generously sized; on a miss it grows ×8.
const TAIL_WINDOW_BYTES = 256 * 1024;

function transcriptPathFor(sessionId: string, cwd: string): string {
  const encoded = cwd.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}

// `transcriptPath` (when given) is the ground truth the hook receives — use it
// verbatim. The cwd-based reconstruction is only a fallback: the transcript is
// keyed by the session's LAUNCH directory, which is neither the current cwd
// (the agent may have cd'd) nor the flow's repoRoot (in a monorepo sub-project
// the anchor differs from the launch dir). Passing repoRoot there silently read
// the wrong/empty file and disabled the context warn/block guard.
export function readTokenCount(sessionId: string, cwd: string, transcriptPath?: string): number {
  const p = transcriptPath && transcriptPath.length > 0 ? transcriptPath : transcriptPathFor(sessionId, cwd);
  if (!existsSync(p)) return 0;
  // We only want the LAST assistant entry carrying a usage block, so read the
  // tail and walk backwards — the first hit is already the answer. Reading and
  // parsing the whole file cost ~27ms and ~110MB of transient allocation on a
  // 16MB transcript, and this runs on every PostToolUse Edit/Write — i.e. most
  // often exactly when the file is largest.
  let fd: number | null = null;
  try {
    fd = openSync(p, 'r');
    const size = fstatSync(fd).size;
    if (size === 0) return 0;
    for (let window = TAIL_WINDOW_BYTES; ; window *= 8) {
      const start = Math.max(0, size - window);
      const buf = Buffer.allocUnsafe(size - start);
      // Honour the actual byte count: the buffer is uninitialised, and a short
      // read would leave garbage at its tail — which a backwards scan hits FIRST.
      const bytesRead = readSync(fd, buf, 0, buf.length, start);
      const lines = buf.subarray(0, bytesRead).toString('utf-8').split('\n');
      // A window that doesn't start at byte 0 almost certainly cuts a line (and
      // possibly a multi-byte char) in half — that debris is confined to the
      // first element, so drop it. It is never the entry we're after: any line
      // we skip here is covered by the next, larger window.
      if (start > 0) lines.shift();
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue;
        try {
          const entry = JSON.parse(lines[i]!) as { type?: string; message?: { usage?: TokenUsage } };
          const usage = entry.type === 'assistant' ? entry.message?.usage : undefined;
          if (usage) {
            return (
              (usage.input_tokens ?? 0) +
              (usage.cache_creation_input_tokens ?? 0) +
              (usage.cache_read_input_tokens ?? 0)
            );
          }
        } catch { /* skip malformed lines */ }
      }
      if (start === 0) return 0; // whole file scanned, no usage entry
    }
  } catch {
    return 0;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

export function contextPct(sessionId: string, cwd: string, contextWindowSize: number, transcriptPath?: string): number {
  if (contextWindowSize <= 0) return 0;
  const tokens = readTokenCount(sessionId, cwd, transcriptPath);
  return Math.round((tokens / contextWindowSize) * 100);
}

export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

/**
 * Parse context window size from model name.
 * Handles suffix hints like [1m] or [200k] (e.g. "claude-sonnet-4-6[1m]").
 * Falls back to DEFAULT_CONTEXT_WINDOW if unparseable.
 */
export function contextWindowForModel(model: string | undefined): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  const m = /\[(\d+(?:\.\d+)?)(k|m)\]/i.exec(model);
  if (m) {
    const n = parseFloat(m[1]!);
    const unit = m[2]!.toLowerCase();
    return unit === 'm' ? Math.round(n * 1_000_000) : Math.round(n * 1_000);
  }
  return DEFAULT_CONTEXT_WINDOW;
}
