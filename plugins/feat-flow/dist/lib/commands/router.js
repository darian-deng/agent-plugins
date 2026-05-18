import { isInitDone } from '../state.js';
import { HELP_TEXT } from './help.js';
import { handleInit } from './init.js';
import { handleStart } from './start.js';
import { handleApprove } from './approve.js';
import { handleAbort } from './abort.js';
import { handleResume } from './resume.js';
import { handleStatus } from './status.js';
import { HELPER_PATH } from '../config.js';
const HELPER_REMINDER = `如需了解 feat-flow 工作流规则，参见：${HELPER_PATH}`;
function deny(reason) {
    const out = {
        hookEventName: 'UserPromptSubmit',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
    };
    return { hookSpecificOutput: out };
}
function allow(additionalContext, systemMessage) {
    const out = {
        hookEventName: 'UserPromptSubmit',
        ...(additionalContext !== undefined && { additionalContext }),
    };
    return {
        ...(systemMessage !== undefined && { systemMessage }),
        hookSpecificOutput: out,
    };
}
export async function handleUserPromptSubmit(input) {
    const { cwd, user_prompt } = input;
    const prompt = user_prompt.trim();
    if (!(/^feat-flow\s/i.test(prompt) || prompt.toLowerCase() === 'feat-flow')) {
        // Non feat-flow messages always pass through
        return allow();
    }
    const subCmd = prompt.replace(/^feat-flow\s*/i, '').split(/\s/)[0]?.toLowerCase() ?? '';
    // ── init command — always allowed, never auto-init before it ───────────────
    if (subCmd === 'init') {
        return handleInit(input);
    }
    // ── auto-init: run init silently if this project hasn't been initialised ───
    if (!isInitDone(cwd)) {
        const initResult = await handleInit(input);
        // If init itself failed (scope wrong, no Node, no git), surface that error
        const initOut = initResult.hookSpecificOutput;
        if (initOut?.permissionDecision === 'deny') {
            return initResult;
        }
        // Init succeeded — fall through to the original command
    }
    let result;
    switch (subCmd) {
        case 'start':
            result = await handleStart(input);
            break;
        case 'approve':
            result = await handleApprove(input);
            break;
        case 'abort':
            result = await handleAbort(input);
            break;
        case 'resume':
            result = await handleResume(input);
            break;
        case 'status':
            result = await handleStatus(input);
            break;
        case 'help':
        case '':
            result = allow(HELP_TEXT + '\n\n' + HELPER_REMINDER);
            break;
        default:
            result = deny(`未知命令：feat-flow ${subCmd}\n\n` + HELP_TEXT);
            break;
    }
    // Append helper reminder to additionalContext for all feat-flow commands
    if (result.hookSpecificOutput && 'additionalContext' in result.hookSpecificOutput) {
        const existing = result.hookSpecificOutput.additionalContext ?? '';
        if (!existing.includes('helper.md')) {
            result.hookSpecificOutput.additionalContext =
                existing + (existing ? '\n\n' : '') + HELPER_REMINDER;
        }
    }
    return result;
}
//# sourceMappingURL=router.js.map