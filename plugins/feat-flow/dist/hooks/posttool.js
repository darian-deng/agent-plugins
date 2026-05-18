#!/usr/bin/env node
import { readFileSync } from 'fs';
import { handlePostToolUse } from '../lib/posttool-handler.js';
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
    const result = await handlePostToolUse(input);
    if (result)
        process.stdout.write(JSON.stringify(result));
}
catch (e) {
    process.stderr.write(`[feat-flow posttool error] ${String(e)}\n`);
}
//# sourceMappingURL=posttool.js.map