import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface TokenUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Build transcript path from session_id and cwd */
function transcriptPath(sessionId: string, cwd: string): string {
  const encoded = cwd.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}

/**
 * Read the last assistant entry's token usage from the session JSONL transcript.
 * Returns total input tokens (including cache).
 */
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

export function contextPct(sessionId: string, cwd: string, contextSize: number): number {
  if (contextSize <= 0) return 0;
  const tokens = readTokenCount(sessionId, cwd);
  return Math.round((tokens / contextSize) * 100);
}
