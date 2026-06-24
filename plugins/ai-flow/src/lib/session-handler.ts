import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { SessionStartInput } from './types.js';
import {
  resolveActiveFlow,
  writeActiveState,
  readSignal,
  isGatePending,
  nextStage,
  appendLog,
  activeJsonPath,
  gcRegistry,
} from './state.js';
import { bindSession } from './session-registry.js';
import { truncateError, flowStatusLine } from './format.js';
import { loadFlowConfig, getStageConfig } from './flow-config-loader.js';
import { contextWindowForModel } from './context.js';
import { advanceStage } from './advance-stage.js';
import { renderPrompt, buildAiFlowPreamble, gateProtocolNote } from './prompt-render.js';


export async function handleSessionStart(
  input: SessionStartInput
): Promise<{ additionalContext: string; systemMessage?: string } | null> {
  const { cwd, session_id, model } = input;

  // Prune dead bindings opportunistically (best-effort, never throws).
  await gcRegistry().catch(() => {});

  const active = await resolveActiveFlow(cwd, session_id).catch(() => null);
  if (!active) return null;

  const { flowName, state, repoRoot } = active;

  try {
  await appendLog(repoRoot, flowName, session_id, `SESSION source=${input.source} stage=${state.current_stage}`);

  // ── Session Mutex (read-only mode) ────────────────────────────────────────────
  // Another session owns this flow. Rather than locking this session out entirely,
  // let it read / search / answer questions about the project — just not modify it
  // (PreToolUse blocks Edit/Write/NotebookEdit) or drive the flow. We return early
  // WITHOUT binding ownership or injecting the stage prompt, so the owner stays in
  // control and this session is never nudged into advancing the flow.
  if (state.last_session_id && state.last_session_id !== session_id) {
    await appendLog(repoRoot, flowName, session_id, `SESSION_READONLY owner=${state.last_session_id}`);

    const activeFile = activeJsonPath(repoRoot, flowName);
    const statusLine = `[ai-flow:${flowName}] 工程进行中，本 session 只读（禁止修改项目与流程命令）`;
    const lines = [
      `[ai-flow] 当前工程已在进行流程 '${flowName}'（由另一 session 控制）。`,
      ``,
      `为避免多 session 并发改动冲突，本 session 仅可读取、检索、回答关于本项目的问题，`,
      `禁止修改本项目文件（Edit/Write/NotebookEdit 将被拒绝），也不要执行任何 ai-flow 流程命令。`,
      ``,
      `当用户要求修改本项目时，请如实告知：改动需在控制该流程的 session 中进行；`,
      `若那个 session 已结束、需由本 session 接管流程，执行 /clear 即可接管`,
      `（如确认原 session 已不存在却仍被锁定，先打开 ${activeFile}，`,
      `把 "last_session_id" 改为 null 保存，再 /clear）。`,
    ];
    return { additionalContext: lines.join('\n'), systemMessage: statusLine };
  }
  // ─────────────────────────────────────────────────────────────────────────────

  const isNewSession = state.last_session_id !== session_id;
  // /clear and compact keep the same session_id, so isNewSession stays false.
  // Detect them via source to ensure context state is properly reset.
  const isClear = input.source === 'compact' || input.source === 'clear';

  // Note: there is an inherent TOCTOU race here — two sessions could both read
  // last_session_id=null and both pass the mutex check above before either writes.
  // The atomic rename in writeActiveState prevents torn writes but not this race.
  // In practice, two Claude Code sessions opening the same repo within milliseconds
  // is rare enough that we accept the risk rather than add a lockfile.

  // Track all sessions that have ever owned this flow (append-only).
  const newHistoryIds = [...(state.history_session_ids ?? [])];
  if (isNewSession && !newHistoryIds.includes(session_id)) {
    newHistoryIds.push(session_id);
  }

  const updated = {
    ...state,
    last_session_id: session_id,
    history_session_ids: newHistoryIds,
    ...(input.source === 'startup' && { context_size: contextWindowForModel(model) }),
  };
  if (isNewSession || isClear) {
    updated.context_warning = { warned: false, warned_at_pct: null, warned_at: null };
    updated.context_blocked = false;
    // Reset so UserPromptSubmit Layer 2 re-injects resume guidance on the next prompt
    updated.first_prompt_handled = false;
  }
  await writeActiveState(repoRoot, flowName, updated);
  // (Re)bind this session to the anchor. Covers flows started before bindings
  // existed, and re-anchors after a session takeover / resume.
  bindSession(session_id, repoRoot, flowName);

  const config = await loadFlowConfig(repoRoot, flowName);
  const stageCfg = getStageConfig(config, state.current_stage);

  // ─── Session Recovery State Matrix ───────────────────────────────────────────
  // Read current signal state
  const signal = readSignal(repoRoot, flowName);
  const expectedNext = nextStage(config, state.current_stage);

  // Determine expected signal content for non-terminal stage
  const expectedSignalContent = expectedNext !== null ? expectedNext : 'flow-complete';

  // S1: AI wrote 'done' but posttool/advance hadn't processed it yet (crash recovery)
  const isSignalValid = signal === 'done';

  // S2: flow-complete signal at terminal stage
  const isFlowComplete = signal === 'flow-complete' && expectedNext === null;

  const pathsPreamble = buildAiFlowPreamble(repoRoot, flowName, state.base_sha_code);

  // S1 + gate: gate pending
  if (isGatePending(signal, config, state.current_stage)) {
    await appendLog(repoRoot, flowName, session_id, `SESSION_GATE_PENDING stage=${state.current_stage}`);
    const statusLine = flowStatusLine({
      flowName,
      stageId: state.current_stage,
      flowId: state.flow_id,
      gatePending: true,
      recovered: true,
    });
    const isTerminal = expectedNext === null;
    const lines: string[] = [
      `[ai-flow] 流程 '${flowName}' 恢复中，Stage '${state.current_stage}' 已提交，等待用户确认。`,
      ``,
      `Signal 已写入但用户尚未执行 approve。`,
      isTerminal
        ? `提醒用户检查 '${state.current_stage}' 的产物后执行：${flowName} approve（终端阶段，approve 后流程结束）`
        : `提醒用户检查 '${state.current_stage}' 的产物后执行：${flowName} approve`,
      ``,
      `如需修改，继续讨论，完成后重新写入 signal。`,
      isTerminal ? `不要擅自结束流程，等待开发者 approve。` : `不要开始下一阶段工作。`,
    ];
    return { additionalContext: pathsPreamble + lines.join('\n'), systemMessage: statusLine };
  }

  // S2: flow-complete signal at terminal stage (no gate) — self-heal
  if (isFlowComplete && !stageCfg.completion.gate) {
    await appendLog(repoRoot, flowName, session_id, `SESSION_SELF_HEAL_COMPLETE stage=${state.current_stage}`);
    const result = await advanceStage(repoRoot, flowName, session_id);
    return { additionalContext: pathsPreamble + result.additionalContext };
  }

  // S1 + none/script: self-heal advance
  if (isSignalValid && !isGatePending(signal, config, state.current_stage)) {
    await appendLog(repoRoot, flowName, session_id, `SESSION_SELF_HEAL_ADVANCE stage=${state.current_stage}`);
    const result = await advanceStage(repoRoot, flowName, session_id);
    // expectedNext is the stage we just advanced into (it was the signal value)
    const base = { additionalContext: pathsPreamble + result.additionalContext };
    if (!result.terminal && expectedNext) {
      return { ...base, systemMessage: flowStatusLine({ flowName, stageId: expectedNext, flowId: state.flow_id, gatePending: false, recovered: false }) };
    }
    return base;
  }

  // S0 (no signal), S3 (stale/invalid content), or invalid → Normal recovery
  // Inject current stage prompt
  await appendLog(repoRoot, flowName, session_id, `SESSION_NORMAL stage=${state.current_stage}`);

  const promptPath = join(repoRoot, '.ai-flow', flowName, stageCfg.prompt);
  let promptContent = '';
  if (existsSync(promptPath)) {
    try {
      promptContent = renderPrompt(readFileSync(promptPath, 'utf-8'), repoRoot, flowName);
    } catch { /* non-fatal */ }
  }
  if (stageCfg.completion.gate) promptContent += '\n' + gateProtocolNote();

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
    `阶段完成后，将 'done' 写入 signal 文件触发推进（引擎自动计算下一步）。`,
  ];

  return { additionalContext: pathsPreamble + lines.join('\n'), systemMessage: statusLine };
  } catch (e) {
    try {
      await appendLog(repoRoot, flowName, session_id, `ERROR session: ${truncateError(e)}`);
    } catch { /* appendLog itself failed — nothing more to do */ }
    return null;
  }
}
