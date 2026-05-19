#!/usr/bin/env node
import { readFileSync } from 'fs';
import { handlePostTool } from '../lib/posttool-handler.js';
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
    const result = await handlePostTool(input);
    if (result) {
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: result.additionalContext }
        }));
    }
}
catch (e) {
    process.stderr.write(`[ai-flow posttool error] ${String(e)}\n`);
}
//# sourceMappingURL=posttool.js.map