import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import {
  readActiveState,
  patchActiveState,
  nextStage,
  appendLog,
  activeJsonPath,
  signalPath,
  materializeRenderedPrompt,
  clearRenderedPrompt,
} from './state.js';
import { loadFlowConfig, getStageConfig } from './flow-config-loader.js';
import { renderPrompt, injectableStagePrompt, assembledOverhead, gateProtocolNote } from './prompt-render.js';

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
/**
 * `callerOverhead` = length of everything the CALLER prepends to `additionalContext` before
 * the host sees it. Every current caller adds the `[ai-flow:paths]` preamble outside this
 * function (~256 chars), and `approve` additionally goes through the command banner (~160) —
 * none of which was counted, so the budget check here under-measured by up to 416 characters
 * on the path that every gated stage takes. Whoever adds must measure: this parameter is how.
 */
export async function advanceStage(repoRoot: string, flowName: string, sessionId: string, callerOverhead = 0): Promise<AdvanceResult> {
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
    // Same reason as the signal: a rendered copy left behind outlives this flow, and the
    // next one would find a complete, plausible prompt from a flow that already ended.
    clearRenderedPrompt(repoRoot, flowName);
    await appendLog(repoRoot, flowName, sessionId, `COMPLETED flow_id=${state.flow_id}`);

    return {
      additionalContext:
        `[ai-flow] 流程 '${flowName}' 全部完成。\n\n` +
        `帮助用户收尾：总结核心产出在哪里，建议下一步（审查、提交等）。保持简洁，突出可操作性。`,
      terminal: true,
    };
  }

  // Drop the previous stage's rendered copy before entering the next one. Without this it
  // survives every transition that injects inline (i.e. most of them), and `helper.md` hands
  // the model that path by name — so a compacted session could Read a complete, plausible
  // prompt belonging to a stage it already left. The stage header inside is the backstop;
  // deleting it is the primary fix.
  clearRenderedPrompt(repoRoot, flowName);

  // Reset first_prompt_handled so Layer 2 re-injects guidance on the first
  // non-command prompt in the newly entered stage (e.g. after approve).
  // Patch, not whole-state write: the read at the top of this function and this
  // write straddle a config load, and a hook that wrote base_sha_code or the
  // ownership fields inside that window must not be undone by the advance.
  const advanced = await patchActiveState(repoRoot, flowName, { current_stage: next, first_prompt_handled: false });
  if (!advanced) {
    return { additionalContext: `[ai-flow] No active flow found for '${flowName}'.`, terminal: true };
  }
  // Clear signal so the new stage starts without a stale trigger
  const sigFile = signalPath(repoRoot, flowName);
  if (existsSync(sigFile)) unlinkSync(sigFile);
  await appendLog(repoRoot, flowName, sessionId, `ADVANCED ${current} → ${next}`);

  const nextStageCfg = getStageConfig(config, next);
  // The host's inline limit applies to the whole `additionalContext`, not to the prompt
  // alone — so the framing has to exist before the size check, and the check has to know
  // how much of the budget the framing already spent.
  const assemble = (body: string) =>
    `[ai-flow] Stage '${current}' 已完成，进入 '${next}'。\n\n` +
    `════════════════════════════════\n` +
    `${body}\n` +
    `════════════════════════════════\n\n` +
    `用 1-2 句自然语言告知用户已进入新阶段，然后直接开始工作，不要等待用户回复。`;
  const promptPath = join(repoRoot, '.ai-flow', flowName, nextStageCfg.prompt);
  // Built before the budget check, not after: a gated stage carries this note too, so its
  // length is part of what the host receives and must be measured with the wrapper.
  const gateNote = nextStageCfg.completion.gate ? '\n' + gateProtocolNote() : '';
  let promptContent = '';
  if (existsSync(promptPath)) {
    try {
      // Oversize prompts are NOT injected in truncated form — see `injectableStagePrompt`.
      promptContent = injectableStagePrompt(
        renderPrompt(readFileSync(promptPath, 'utf-8'), repoRoot, flowName),
        promptPath,
        assembledOverhead(assemble) + gateNote.length + callerOverhead,
        (text) => materializeRenderedPrompt(repoRoot, flowName, next, text)
      );
    } catch { /* non-fatal */ }
  }
  promptContent += gateNote;

  return { additionalContext: assemble(promptContent) };
}
