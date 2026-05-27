import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { hasActiveFlow, writeActiveState, isGateActive, readGateToken, appendHookLog, signalPath } from './state.js';
import { truncateError } from './format.js';
import { loadFlowConfig, getStageConfig } from './flow-config-loader.js';
import { contextWindowForModel } from './context.js';
export async function handleSessionStart(input) {
    const { cwd, session_id, model } = input;
    const active = await hasActiveFlow(cwd).catch(() => null);
    if (!active)
        return null;
    const { flowName, state, repoRoot } = active;
    try {
        await appendHookLog(repoRoot, flowName, `SESSION source=${input.source} session=${session_id.slice(0, 8)} stage=${state.current_stage}`);
        const isNewSession = state.last_session_id !== session_id;
        // /clear and compact keep the same session_id, so isNewSession stays false.
        // Detect them via source to ensure context state is properly reset.
        const isClear = input.source === 'compact' || input.source === 'clear';
        const updated = {
            ...state,
            last_session_id: session_id,
            ...(input.source === 'startup' && { context_size: contextWindowForModel(model) }),
        };
        if (isNewSession || isClear) {
            updated.context_warning = { warned: false, warned_at_pct: null, warned_at: null };
            updated.context_blocked = false;
        }
        await writeActiveState(repoRoot, flowName, updated);
        const config = await loadFlowConfig(repoRoot, flowName);
        const stageCfg = getStageConfig(config, state.current_stage);
        const lines = [
            `Flow '${flowName}' is active.`,
            `flow_id: ${state.flow_id}`,
            `current_stage: ${state.current_stage}`,
            `requirement: ${state.requirement}`,
        ];
        let systemMessage;
        const gateActive = await isGateActive(repoRoot, flowName);
        // Clean up any signal file left over from the previous stage's ADVANCE.
        // Prevents a new session from seeing a stale signal and skipping the current stage.
        if (!gateActive) {
            const sig = signalPath(repoRoot, flowName);
            try {
                if (existsSync(sig))
                    unlinkSync(sig);
            }
            catch { /* non-fatal */ }
        }
        if (gateActive) {
            const token = await readGateToken(repoRoot, flowName);
            const approveCmd = token ? `${flowName} approve ${token}` : `${flowName} approve <token>`;
            lines.push('', `Gate pending — run to approve: ${approveCmd}`);
            // Re-surface the token so the model can give the user the exact command,
            // especially after /clear or session restart when the original system message is gone.
            systemMessage = `[feat-flow] Gate pending for stage '${state.current_stage}'.\nRun: ${approveCmd}`;
        }
        else {
            const promptPath = join(repoRoot, '.ai-flow', flowName, stageCfg.prompt);
            if (existsSync(promptPath)) {
                try {
                    lines.push('', '---', '', readFileSync(promptPath, 'utf-8'));
                }
                catch { /* non-fatal */ }
            }
            systemMessage = `[feat-flow] Active | stage: ${state.current_stage} | flow: ${state.flow_id}`;
        }
        // For both startup and /clear: the model must acknowledge the flow on its
        // very first response so the user sees the flow is active.
        // startup: announce and wait for user direction.
        // clear/compact: announce and immediately continue the task.
        if (!gateActive) {
            if (isClear) {
                lines.unshift(`INSTRUCTION (context was just cleared via /clear):`, `Your FIRST response must begin with a one-line status: "Resuming ${flowName} · ${state.current_stage} · flow ${state.flow_id}"`, `Then immediately continue the task from where you left off — do NOT ask the user what to do next.`, ``);
            }
            else if (input.source === 'startup') {
                lines.unshift(`INSTRUCTION (new session, active flow detected):`, `Your FIRST response must begin with a one-line status: "${flowName} · ${state.current_stage} · flow ${state.flow_id}"`, `Then briefly describe the current stage goal and ask the user how to proceed.`, ``);
            }
        }
        return { additionalContext: lines.join('\n'), systemMessage };
    }
    catch (e) {
        try {
            await appendHookLog(repoRoot, flowName, `ERROR session: ${truncateError(e)}`);
        }
        catch { /* appendHookLog itself failed — nothing more to do */ }
        return null;
    }
}
//# sourceMappingURL=session-handler.js.map