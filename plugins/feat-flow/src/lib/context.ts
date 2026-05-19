import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface TokenUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function transcriptPath(sessionId: string, cwd: string): string {
  const encoded = cwd.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}

export function readTokenCount(sessionId: string, cwd: string): number {
  const p = transcriptPath(sessionId, cwd);
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

export function contextPct(sessionId: string, cwd: string, contextWindowSize: number): number {
  if (contextWindowSize <= 0) return 0;
  const tokens = readTokenCount(sessionId, cwd);
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
