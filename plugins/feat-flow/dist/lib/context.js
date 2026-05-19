import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
function transcriptPath(sessionId, cwd) {
    const encoded = cwd.replace(/\//g, '-');
    return join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}
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
export function contextPct(sessionId, cwd, contextWindowSize) {
    if (contextWindowSize <= 0)
        return 0;
    const tokens = readTokenCount(sessionId, cwd);
    return Math.round((tokens / contextWindowSize) * 100);
}
const MODEL_CONTEXT = {
    'claude-opus-4-7': 200_000,
    'claude-sonnet-4-6': 1_000_000,
    'claude-haiku-4-5': 200_000,
    'claude-haiku-4-5-20251001': 200_000,
};
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
export function contextWindowForModel(model) {
    if (!model)
        return DEFAULT_CONTEXT_WINDOW;
    return MODEL_CONTEXT[model] ?? DEFAULT_CONTEXT_WINDOW;
}
//# sourceMappingURL=context.js.map