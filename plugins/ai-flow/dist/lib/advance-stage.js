import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { readActiveState, writeActiveState, nextStage, appendTransition, appendHookLog, activeJsonPath, signalPath, } from './state.js';
import { loadFlowConfig, getStageConfig } from './flow-config-loader.js';
/**
 * Advance the flow to the next stage. If the current stage is the last one,
 * deletes active.json and returns a flow-complete message.
 *
 * Used by: pretool-handler (none/script), approve.ts, session-handler (self-heal).
 */
export async function advanceStage(repoRoot, flowName) {
    const state = await readActiveState(repoRoot, flowName);
    if (!state) {
        return { additionalContext: `[ai-flow] No active flow found for '${flowName}'.`, terminal: true };
    }
    const config = await loadFlowConfig(repoRoot, flowName);
    const current = state.current_stage;
    const next = nextStage(config, current);
    if (!next) {
        // Terminal stage — complete the flow
        const activeJson = activeJsonPath(repoRoot, flowName);
        if (existsSync(activeJson))
            unlinkSync(activeJson);
        // Clean up signal file so stale 'flow-complete' doesn't trigger S2 self-heal on a future flow
        const sig = signalPath(repoRoot, flowName);
        if (existsSync(sig))
            unlinkSync(sig);
        await appendTransition(repoRoot, flowName, `COMPLETED flow_id=${state.flow_id}`);
        await appendHookLog(repoRoot, flowName, `COMPLETED flow_id=${state.flow_id}`);
        return {
            additionalContext: `[ai-flow] 流程 '${flowName}' 全部完成。\n\n` +
                `帮助用户收尾：总结核心产出在哪里，建议下一步（审查、提交等）。保持简洁，突出可操作性。`,
            terminal: true,
        };
    }
    const updated = { ...state, current_stage: next };
    await writeActiveState(repoRoot, flowName, updated);
    await appendTransition(repoRoot, flowName, `ADVANCED ${current} → ${next}`);
    await appendHookLog(repoRoot, flowName, `ADVANCED ${current} → ${next}`);
    const nextStageCfg = getStageConfig(config, next);
    const promptPath = join(repoRoot, '.ai-flow', flowName, nextStageCfg.prompt);
    let promptContent = '';
    if (existsSync(promptPath)) {
        try {
            promptContent = readFileSync(promptPath, 'utf-8');
        }
        catch { /* non-fatal */ }
    }
    return {
        additionalContext: `[ai-flow] Stage '${current}' 已完成，进入 '${next}'。\n\n` +
            `════════════════════════════════\n` +
            `${promptContent}\n` +
            `════════════════════════════════\n\n` +
            `用 1-2 句自然语言告知用户已进入新阶段，然后直接开始工作，不要等待用户回复。`,
    };
}
//# sourceMappingURL=advance-stage.js.map