import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import {
  readActiveState,
  writeActiveState,
  nextStage,
  appendLog,
  activeJsonPath,
  signalPath,
} from './state.js';
import { loadFlowConfig, getStageConfig } from './flow-config-loader.js';
import { renderPrompt } from './prompt-render.js';

export interface AdvanceResult {
  additionalContext: string;
  terminal?: true;
}

/**
 * Advance the flow to the next stage. If the current stage is the last one,
 * deletes active.json and returns a flow-complete message.
 *
 * Used by: pretool-handler (none/script), approve.ts, session-handler (self-heal).
 */
export async function advanceStage(repoRoot: string, flowName: string, sessionId: string): Promise<AdvanceResult> {
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
    if (existsSync(activeJson)) unlinkSync(activeJson);
    // Clean up signal file so stale 'flow-complete' doesn't trigger S2 self-heal on a future flow
    const sig = signalPath(repoRoot, flowName);
    if (existsSync(sig)) unlinkSync(sig);
    await appendLog(repoRoot, flowName, sessionId, `COMPLETED flow_id=${state.flow_id}`);

    return {
      additionalContext:
        `[ai-flow] 流程 '${flowName}' 全部完成。\n\n` +
        `帮助用户收尾：总结核心产出在哪里，建议下一步（审查、提交等）。保持简洁，突出可操作性。`,
      terminal: true,
    };
  }

  // Reset first_prompt_handled so Layer 2 re-injects guidance on the first
  // non-command prompt in the newly entered stage (e.g. after approve).
  const updated = { ...state, current_stage: next, first_prompt_handled: false };
  await writeActiveState(repoRoot, flowName, updated);
  // Clear signal so the new stage starts without a stale trigger
  const sigFile = signalPath(repoRoot, flowName);
  if (existsSync(sigFile)) unlinkSync(sigFile);
  await appendLog(repoRoot, flowName, sessionId, `ADVANCED ${current} → ${next}`);

  const nextStageCfg = getStageConfig(config, next);
  const promptPath = join(repoRoot, '.ai-flow', flowName, nextStageCfg.prompt);
  let promptContent = '';
  if (existsSync(promptPath)) {
    try {
      promptContent = renderPrompt(readFileSync(promptPath, 'utf-8'), repoRoot, flowName);
    } catch { /* non-fatal */ }
  }

  return {
    additionalContext:
      `[ai-flow] Stage '${current}' 已完成，进入 '${next}'。\n\n` +
      `════════════════════════════════\n` +
      `${promptContent}\n` +
      `════════════════════════════════\n\n` +
      `用 1-2 句自然语言告知用户已进入新阶段，然后直接开始工作，不要等待用户回复。`,
  };
}
