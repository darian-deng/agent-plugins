import { readActiveState, readSignal, isGatePending } from '../state.js';
import { loadFlowConfig } from '../flow-config-loader.js';
export async function handleStatus(repoRoot, flowName) {
    const state = await readActiveState(repoRoot, flowName);
    if (!state) {
        return { action: 'allow', additionalContext: `No active flow for '${flowName}'. Run '${flowName} start <requirement>' to begin.` };
    }
    const lines = [
        `Flow: ${state.flow_name}`,
        `flow_id: ${state.flow_id}`,
        `current_stage: ${state.current_stage}`,
        `requirement: ${state.requirement}`,
    ];
    let gateActive = false;
    try {
        const config = await loadFlowConfig(repoRoot, flowName);
        const signal = readSignal(repoRoot, flowName);
        gateActive = isGatePending(signal, config, state.current_stage);
    }
    catch { /* non-fatal */ }
    if (gateActive) {
        lines.push('', `Gate pending — run '${flowName} approve' to advance to the next stage.`);
    }
    if (state.context_warning.warned) {
        lines.push('', `Context warning: ${state.context_warning.warned_at_pct}% used`);
    }
    return { action: 'allow', additionalContext: lines.join('\n') };
}
//# sourceMappingURL=status.js.map