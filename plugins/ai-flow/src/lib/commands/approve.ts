import { join } from 'path';
import {
  readActiveState,
  readSignal,
  isGatePending,
  appendLog,
} from '../state.js';
import { loadFlowConfig } from '../flow-config-loader.js';
import { advanceStage } from '../advance-stage.js';
import type { CommandResult } from '../types.js';

export async function handleApprove(
  repoRoot: string,
  flowName: string,
  sessionId: string,
  _args?: string
): Promise<CommandResult> {
  const state = await readActiveState(repoRoot, flowName);
  if (!state) {
    return { action: 'deny', reason: 'No active flow. Run the flow start command first.' };
  }

  const config = await loadFlowConfig(repoRoot, flowName);
  const signal = readSignal(repoRoot, flowName);
  const stageCfg = config.stages.find((s) => s.id === state.current_stage);

  if (!signal) {
    return { action: 'deny', reason: `Stage '${state.current_stage}' has not submitted a completion signal yet.` };
  }
  if (!stageCfg?.completion.gate) {
    return { action: 'deny', reason: `Stage '${state.current_stage}' does not require approval (no gate configured).` };
  }
  if (!isGatePending(signal, config, state.current_stage)) {
    return { action: 'deny', reason: `Signal present but does not match the expected checkpoint for stage '${state.current_stage}'.` };
  }

  await appendLog(repoRoot, flowName, sessionId, `APPROVED stage=${state.current_stage}`);

  const result = await advanceStage(repoRoot, flowName, sessionId);
  const flowRoot = join(repoRoot, '.ai-flow', flowName);
  const pathsPreamble = `[ai-flow:paths]\nproject_root: ${repoRoot}\nflow_root: ${flowRoot}\n\n`;
  return { action: 'allow', additionalContext: pathsPreamble + result.additionalContext };
}
