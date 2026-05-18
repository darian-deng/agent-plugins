#!/usr/bin/env node
import { readFileSync } from 'fs';
import { handlePreToolUse } from '../lib/pretool-handler.js';
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
    const result = await handlePreToolUse(input);
    if (result)
        process.stdout.write(JSON.stringify(result));
}
catch (e) {
    process.stderr.write(`[feat-flow pretool error] ${String(e)}\n`);
}
//# sourceMappingURL=pretool.js.map