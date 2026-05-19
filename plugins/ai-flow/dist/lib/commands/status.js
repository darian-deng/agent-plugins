import { readActiveState, isGateActive, readGateToken } from '../state.js';
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
    const gateActive = await isGateActive(repoRoot, flowName);
    if (gateActive) {
        const token = await readGateToken(repoRoot, flowName);
        lines.push('', `Gate pending — run '${flowName} approve <token>'`);
        if (token)
            lines.push(`Token: ${token}`);
    }
    if (state.context_warning.warned) {
        lines.push('', `Context warning: ${state.context_warning.warned_at_pct}% used`);
    }
    return { action: 'allow', additionalContext: lines.join('\n') };
}
//# sourceMappingURL=status.js.map