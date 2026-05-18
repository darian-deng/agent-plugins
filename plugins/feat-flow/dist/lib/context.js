import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
/** Build transcript path from session_id and cwd */
function transcriptPath(sessionId, cwd) {
    const encoded = cwd.replace(/\//g, '-');
    return join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}
/**
 * Read the last assistant entry's token usage from the session JSONL transcript.
 * Returns total input tokens (including cache).
 */
export function readTokenCount(sessionId, cwd) {
    const p = transcriptPath(sessionId, cwd);
    if (!existsSync(p))
        return 0;
    try {
        const lines = readFileSync(p, 'utf-8').split('\n').filter(Boolean);
        let lastUsage = null;
        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (entry.type === 'assistant' && entry.message?.usage) {
                    lastUsage = entry.message.usage;
                }
            }
            catch { /* skip malformed lines */ }
        }
        if (!lastUsage)
            return 0;
        return ((lastUsage.input_tokens ?? 0) +
            (lastUsage.cache_creation_input_tokens ?? 0) +
            (lastUsage.cache_read_input_tokens ?? 0));
    }
    catch {
        return 0;
    }
}
export function contextPct(sessionId, cwd, contextSize) {
    if (contextSize <= 0)
        return 0;
    const tokens = readTokenCount(sessionId, cwd);
    return Math.round((tokens / contextSize) * 100);
}
//# sourceMappingURL=context.js.map