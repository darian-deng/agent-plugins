import {
  readActiveState,
  readSignal,
  isGatePending,
  appendLog,
  nextStage,
} from '../state.js';
import { loadFlowConfig } from '../flow-config-loader.js';
import { advanceStage } from '../advance-stage.js';
import { buildAiFlowPreamble } from '../prompt-render.js';
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

  // Compute the stage we're about to enter (null = current is terminal) BEFORE
  // advancing, so we can give the user a deterministic, instant confirmation
  // that approve succeeded — independent of whether the model speaks first.
  const enteredStage = nextStage(config, state.current_stage);
  const result = await advanceStage(repoRoot, flowName, sessionId);
  const systemMessage = result.terminal
    ? `[${flowName}] ✅ 流程已结束`
    : `[${flowName}] ✅ 已进入 ${enteredStage} · 正在读取阶段文档…`;
  const pathsPreamble = buildAiFlowPreamble(repoRoot, flowName, state.base_sha_code);
  return { action: 'allow', systemMessage, additionalContext: pathsPreamble + result.additionalContext };
}
