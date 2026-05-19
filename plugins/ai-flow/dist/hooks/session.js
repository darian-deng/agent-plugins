#!/usr/bin/env node
import { readFileSync } from 'fs';
import { handleSessionStart } from '../lib/session-handler.js';
const raw = (() => { try {
    return readFileSync(0, 'utf-8');
}
catch {
    return '{}';
} })();
const input = (() => { try {
    return JSON.parse(raw);
}
catch {
    return {};
} })();
try {
    const result = await handleSessionStart(input);
    if (result) {
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: result.additionalContext }
        }));
    }
}
catch (e) {
    process.stderr.write(`[ai-flow session error] ${String(e)}\n`);
}
//# sourceMappingURL=session.js.map