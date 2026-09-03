import { readActiveState, readSignal, isGatePending, nextStage } from '../state.js';
import { loadFlowConfig, getStageConfig, resolveDocsPaths } from '../flow-config-loader.js';
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

  let gateActive = false;
  let gateTerminal = false;
  // Empty means "nothing is refused", and it says so for both reasons it can be
  // empty: the stage declares no docs_paths (pretool then skips the wrap-up refusal
  // — it has no safe exit to keep open), or the config would not load at all (in
  // which case pretool's catch-all has already dropped every guard). Both end in the
  // same observable state, so one line covers them.
  let wrapUpDocs: string[] = [];
  try {
    const config = await loadFlowConfig(repoRoot, flowName);
    const signal = readSignal(repoRoot, flowName);
    gateActive = isGatePending(signal, config, state.current_stage);
    gateTerminal = nextStage(config, state.current_stage) === null;
    wrapUpDocs = resolveDocsPaths(
      getStageConfig(config, state.current_stage).docs_paths ?? [],
      state.flow_id
    );
  } catch { /* non-fatal */ }

  if (gateActive) {
    lines.push('', gateTerminal
      ? `Gate pending — run '${flowName} approve' to confirm and end the flow.`
      : `Gate pending — run '${flowName} approve' to advance to the next stage.`);
  }

  if (state.context_wrap_up.at_pct !== null) {
    lines.push('', wrapUpDocs.length > 0
      ? `Context wrap-up started at ${state.context_wrap_up.at_pct}% used — writes to the codebase are refused; writes to ${wrapUpDocs.join(', ')} stay open so a handoff can land.`
      : `Context wrap-up started at ${state.context_wrap_up.at_pct}% used — stage '${state.current_stage}' declares no docs_paths, so no write is being refused (refusing them would leave nowhere to write the handoff). Land the handoff in the repo and /clear.`);
  }

  return { action: 'allow', additionalContext: lines.join('\n') };
}
