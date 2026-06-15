import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface TokenUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

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
  try {
    const lines = readFileSync(p, 'utf-8').split('\n').filter(Boolean);
    let lastUsage: TokenUsage | null = null;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { type?: string; message?: { usage?: TokenUsage } };
        if (entry.type === 'assistant' && entry.message?.usage) {
          lastUsage = entry.message.usage;
        }
      } catch { /* skip malformed lines */ }
    }
    if (!lastUsage) return 0;
    return (
      (lastUsage.input_tokens ?? 0) +
      (lastUsage.cache_creation_input_tokens ?? 0) +
      (lastUsage.cache_read_input_tokens ?? 0)
    );
  } catch {
    return 0;
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
