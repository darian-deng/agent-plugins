import { readActiveState, isGateActive } from '../state.js';
import type { CommandResult } from '../types.js';

export async function handleStatus(repoRoot: string, flowName: string): Promise<CommandResult> {
  const state = await readActiveState(repoRoot, flowName);
  if (!state) {
    return { action: 'allow', additionalContext: `No active flow for '${flowName}'. Run '${flowName} start <requirement>' to begin.` };
  }

  const lines: string[] = [
    `Flow: ${state.flow_name}`,
    `flow_id: ${state.flow_id}`,
    `current_stage: ${state.current_stage}`,
    `requirement: ${state.requirement}`,
  ];

  const gateActive = await isGateActive(repoRoot, flowName);
  if (gateActive) {
    lines.push('', `Gate pending — run '${flowName} approve <token>'`);
    lines.push(`The token was delivered via system message. If you dismissed it, retrieve it with:`);
    lines.push(`  ! cat .ai-flow/${flowName}/state/gate-token`);
  }

  if (state.context_warning.warned) {
    lines.push('', `Context warning: ${state.context_warning.warned_at_pct}% used`);
  }

  return { action: 'allow', additionalContext: lines.join('\n') };
}
