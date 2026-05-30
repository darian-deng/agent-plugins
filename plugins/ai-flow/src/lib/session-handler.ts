import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { SessionStartInput } from './types.js';
import {
  hasActiveFlow,
  writeActiveState,
  readSignal,
  isGatePending,
  nextStage,
  appendHookLog,
} from './state.js';
import { truncateError, flowStatusLine } from './format.js';
import { loadFlowConfig, getStageConfig } from './flow-config-loader.js';
import { contextWindowForModel } from './context.js';
import { advanceStage } from './advance-stage.js';


export async function handleSessionStart(
  input: SessionStartInput
): Promise<{ additionalContext: string; systemMessage?: string } | null> {
  const { cwd, session_id, model } = input;

  const active = await hasActiveFlow(cwd).catch(() => null);
  if (!active) return null;

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
    // Reset so UserPromptSubmit Layer 2 re-injects resume guidance on the next prompt
    updated.first_prompt_handled = false;
  }
  await writeActiveState(repoRoot, flowName, updated);

  const config = await loadFlowConfig(repoRoot, flowName);
  const stageCfg = getStageConfig(config, state.current_stage);

  // ─── Session Recovery State Matrix ───────────────────────────────────────────
  // Read current signal state
  const signal = readSignal(repoRoot, flowName);
  const expectedNext = nextStage(config, state.current_stage);

  // Determine expected signal content for non-terminal stage
  const expectedSignalContent = expectedNext !== null ? expectedNext : 'flow-complete';

  // S1: signal matches expected next stage content
  const isSignalValid = signal !== null && signal === expectedSignalContent;

  // S2: flow-complete signal at terminal stage
  const isFlowComplete = signal === 'flow-complete' && expectedNext === null;

  const flowRoot = join(repoRoot, '.ai-flow', flowName);
  const pathsPreamble = `[ai-flow:paths]\nproject_root: ${repoRoot}\nflow_root: ${flowRoot}\n\n`;

  // S1 + gate: gate pending
  if (isGatePending(signal, config, state.current_stage)) {
    await appendHookLog(repoRoot, flowName, `SESSION_GATE_PENDING stage=${state.current_stage}`);
    const statusLine = flowStatusLine({
      flowName,
      stageId: state.current_stage,
      flowId: state.flow_id,
      gatePending: true,
      recovered: true,
    });
    const lines: string[] = [
      `[ai-flow] 流程 '${flowName}' 恢复中，Stage '${state.current_stage}' 已提交，等待用户确认。`,
      ``,
      `Signal 已写入但用户尚未执行 approve。`,
      `提醒用户检查 '${state.current_stage}' 的产物后执行：${flowName} approve`,
      ``,
      `如需修改，继续讨论，完成后重新写入 signal。`,
      `不要开始下一阶段工作。`,
    ];
    return { additionalContext: pathsPreamble + lines.join('\n'), systemMessage: statusLine };
  }

  // S2: flow-complete signal at terminal stage (no gate) — self-heal
  if (isFlowComplete && !stageCfg.completion.gate) {
    await appendHookLog(repoRoot, flowName, `SESSION_SELF_HEAL_COMPLETE stage=${state.current_stage}`);
    const result = await advanceStage(repoRoot, flowName);
    return { additionalContext: pathsPreamble + result.additionalContext };
  }

  // S1 + none/script: self-heal advance
  if (isSignalValid && !isGatePending(signal, config, state.current_stage)) {
    await appendHookLog(repoRoot, flowName, `SESSION_SELF_HEAL_ADVANCE stage=${state.current_stage}`);
    const result = await advanceStage(repoRoot, flowName);
    // expectedNext is the stage we just advanced into (it was the signal value)
    const base = { additionalContext: pathsPreamble + result.additionalContext };
    if (!result.terminal && expectedNext) {
      return { ...base, systemMessage: flowStatusLine({ flowName, stageId: expectedNext, flowId: state.flow_id, gatePending: false, recovered: false }) };
    }
    return base;
  }

  // S0 (no signal), S3 (stale/invalid content), or invalid → Normal recovery
  // Inject current stage prompt
  await appendHookLog(repoRoot, flowName, `SESSION_NORMAL stage=${state.current_stage}`);

  const promptPath = join(repoRoot, '.ai-flow', flowName, stageCfg.prompt);
  let promptContent = '';
  if (existsSync(promptPath)) {
    try {
      promptContent = readFileSync(promptPath, 'utf-8');
    } catch { /* non-fatal */ }
  }

  const statusLine = flowStatusLine({
    flowName,
    stageId: state.current_stage,
    flowId: state.flow_id,
    gatePending: false,
    recovered: true,
  });

  const lines: string[] = [
    `[ai-flow] 流程 '${flowName}' 恢复中，当前处于 '${state.current_stage}'。`,
    ``,
    `════════════════════════════════`,
    promptContent,
    `════════════════════════════════`,
    ``,
    `阶段完成后，将 '${expectedSignalContent}' 写入 signal 文件触发推进。`,
  ];

  return { additionalContext: pathsPreamble + lines.join('\n'), systemMessage: statusLine };
  } catch (e) {
    try {
      await appendHookLog(repoRoot, flowName, `ERROR session: ${truncateError(e)}`);
    } catch { /* appendHookLog itself failed — nothing more to do */ }
    return null;
  }
}
