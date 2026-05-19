#!/usr/bin/env node
import { readFileSync } from 'fs';
import { handlePreTool } from '../lib/pretool-handler.js';
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
    const result = await handlePreTool(input);
    if (result) {
        const { systemMessage, ...decision } = result;
        const out = {
            hookSpecificOutput: { hookEventName: 'PreToolUse', ...decision },
        };
        if (systemMessage)
            out['systemMessage'] = systemMessage;
        process.stdout.write(JSON.stringify(out));
    }
}
catch (e) {
    process.stderr.write(`[ai-flow pretool error] ${String(e)}\n`);
}
//# sourceMappingURL=pretool.js.map