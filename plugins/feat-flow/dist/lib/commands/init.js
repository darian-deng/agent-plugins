import { runInit } from '../init-handler.js';
export async function handleInit(input) {
    const { cwd } = input;
    const result = await runInit(cwd);
    if (!result.ok) {
        const out = {
            hookEventName: 'UserPromptSubmit',
            permissionDecision: 'deny',
            permissionDecisionReason: result.reason ?? 'feat-flow init 失败',
        };
        return { hookSpecificOutput: out };
    }
    const out = {
        hookEventName: 'UserPromptSubmit',
        additionalContext: result.message ?? '✅ feat-flow 已初始化',
    };
    return { hookSpecificOutput: out };
}
//# sourceMappingURL=init.js.map