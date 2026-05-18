#!/usr/bin/env node
import { readFileSync } from 'fs';
import { handleUserPromptSubmit } from '../lib/commands/router.js';
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
// Informational commands: block the turn so Claude doesn't process "feat-flow help/status"
// as a user message (which would cause Claude to try invoking a non-existent skill).
// Action commands (start/approve/abort/resume) need Claude to continue — use additionalContext.
const INFORMATIONAL_CMDS = new Set(['help', 'status', '', 'init']);
const rawSubCmd = (input.prompt ?? '')
    .replace(/^feat-flow\s*/i, '').split(/\s/)[0]?.toLowerCase() ?? '';
try {
    const result = await handleUserPromptSubmit(input);
    if (!result)
        process.exit(0);
    const out = result.hookSpecificOutput;
    // Hard deny: exit 2 + stderr (e.g. unknown command, scope error)
    if (out?.permissionDecision === 'deny') {
        process.stderr.write((out.permissionDecisionReason ?? 'Blocked by feat-flow') + '\n');
        process.exit(2);
    }
    // Informational commands: use decision:block so the response appears in chat
    // directly without Claude trying to process the original "feat-flow help" message.
    if (INFORMATIONAL_CMDS.has(rawSubCmd) && out?.additionalContext) {
        process.stdout.write(JSON.stringify({ decision: 'block', reason: out.additionalContext }));
        process.exit(0);
    }
    // Action commands: allow through with additionalContext so Claude continues working.
    const { permissionDecision: _, permissionDecisionReason: __, ...cleanOut } = out ?? {};
    process.stdout.write(JSON.stringify({ ...result, hookSpecificOutput: cleanOut }));
}
catch (e) {
    process.stderr.write(`[feat-flow userprompt error] ${String(e)}\n`);
}
//# sourceMappingURL=userprompt.js.map