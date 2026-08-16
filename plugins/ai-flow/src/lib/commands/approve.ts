import { join } from 'path';
import {
  readActiveState,
  readSignal,
  isGatePending,
  appendLog,
  nextStage,
} from '../state.js';
import { loadFlowConfig } from '../flow-config-loader.js';
import { advanceStage } from '../advance-stage.js';
import { runScript } from '../script-executor.js';
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

  // ─── Release-time script gate re-check (P1-6) ────────────────────────────────
  // The completion.script gate only ran once, when the AI wrote signal=done. The
  // flow then sat in gate-pending awaiting approve — a window in which the
  // deliverable can still change (new tickets, edited specs) and slip past the
  // fail-closed structural gate. The gate's meaning is "the deliverable is
  // compliant at the moment of release", not "at the moment of signal". So when
  // this stage configured a script gate, re-run it here, before advancing. The
  // script is a fail-closed structural check — idempotent and second-scale — so
  // re-running is safe. Reuse the exact runner + cwd (flowDir) used at signal
  // time in pretool-handler; on failure, refuse approve and hand back the
  // script's own stderr so the developer/AI can fix and re-approve. Stages with
  // no script gate (pure gate / no gate) keep their prior approve behavior.
  let gateNotes: string | undefined;
  if (stageCfg.completion.script) {
    const flowDir = join(repoRoot, '.ai-flow', flowName);
    const scriptOpts = stageCfg.completion.script.timeout_ms !== undefined
      ? { timeout_ms: stageCfg.completion.script.timeout_ms }
      : undefined;
    const scriptResult = await runScript(stageCfg.completion.script.command, flowDir, scriptOpts);
    if (!scriptResult.ok) {
      await appendLog(repoRoot, flowName, sessionId, `APPROVE_SCRIPT_FAIL stage=${state.current_stage} reason=${scriptResult.reason.replace(/\n/g, ' ').slice(0, 80)}`);
      return {
        action: 'deny',
        reason:
          `放行前结构门复检失败:阶段 '${state.current_stage}' 的完成脚本未通过。\n` +
          `脚本:${stageCfg.completion.script.command}\n\n` +
          `${scriptResult.reason}\n\n` +
          `gate-pending 期间产物被改动到不合规状态。请修复上述问题后重新 approve。`,
      };
    }
    await appendLog(repoRoot, flowName, sessionId, `APPROVE_SCRIPT_OK stage=${state.current_stage}`);
    // A passing gate can still report assertions it had to skip — carry them out.
    if (scriptResult.notes) gateNotes = scriptResult.notes;
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
  return {
    action: 'allow',
    systemMessage: gateNotes ? `${gateNotes}\n\n${systemMessage}` : systemMessage,
    additionalContext: pathsPreamble + result.additionalContext,
  };
}
