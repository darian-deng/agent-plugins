import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { SessionStartInput } from './types.js';
import {
  resolveActiveFlow,
  patchActiveState,
  readSignal,
  isGatePending,
  nextStage,
  appendLog,
  activeJsonPath,
  gcRegistry,
  type ActiveState,
  materializeRenderedPrompt,
} from './state.js';
import { bindSession } from './session-registry.js';
import { truncateError, flowStatusLine } from './format.js';
import { loadFlowConfig, getStageConfig } from './flow-config-loader.js';
import { contextWindowForModel } from './context.js';
import { advanceStage } from './advance-stage.js';
import { renderPrompt, injectableStagePrompt, assembledOverhead, buildAiFlowPreamble, gateProtocolNote, writtenDocLengthNote } from './prompt-render.js';


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
  // patchActiveState makes the write itself lose nothing, but it cannot undo a
  // check that already passed on stale data. In practice, two Claude Code sessions
  // opening the same repo within milliseconds is rare enough that we accept the
  // risk rather than gate the whole handler on the lock.
  await patchActiveState(repoRoot, flowName, (cur) => {
    // history_session_ids is append-only, so it must extend the list as it stands
    // now — extending the entry-time copy would drop a concurrently added owner.
    const historyIds = [...(cur.history_session_ids ?? [])];
    if (isNewSession && !historyIds.includes(session_id)) historyIds.push(session_id);
    const patch: Partial<ActiveState> = {
      last_session_id: session_id,
      history_session_ids: historyIds,
      ...(input.source === 'startup' && { context_size: contextWindowForModel(model) }),
    };
    if (isNewSession || isClear) {
      patch.context_warning = { warned: false, warned_at_pct: null, warned_at: null };
      patch.context_blocked = false;
      // Reset so UserPromptSubmit Layer 2 re-injects resume guidance on the next prompt
      patch.first_prompt_handled = false;
    }
    return patch;
  });
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
    // The stage prompt is NOT injected on this branch (it would be redundant for the
    // common case: approve arrives, advance-stage injects the next stage). But a /clear
    // that lands here leaves the model with no stage instructions at all, and gate-pending
    // is where /clear is most likely — the developer is reading a large review surface
    // while the main session sits at its context peak. Two silent losses follow:
    // edits made ON the gate skip the "regenerate the derived view" rule, and a terminal
    // stage's post-approve action (amend the knowledge write-up into the squashed commit)
    // is never seen, because `approve` is a flow command and so bypasses the
    // UserPromptSubmit resume-guidance layer too. So point at the file instead of
    // inlining it — the whole branch lands around 700 characters, far under
    // INLINE_INJECTION_BUDGET, and pointing avoids handing a "go do this stage" document
    // to a session whose stage is already submitted and merely awaiting approval.
    // Point at a RENDERED copy, not at `stages/<id>.md`. The template still has literal
    // `{{flow_root}}` / `{{project_root}}` (substitution happens in renderPrompt, i.e. only
    // on the injection path) and lacks the notes the engine appends — and copying a literal
    // placeholder into Write is silent, it just creates a directory by that name. Falls back
    // to the template path if the write fails; the message below says which one you got.
    //
    // Deliberately no existsSync on the template (unlike the normal-recovery path further
    // down): a failed Read is a VISIBLE error, which beats that path's silent degradation to
    // an empty prompt body. Don't "unify" the two.
    const templatePath = join(repoRoot, '.ai-flow', flowName, stageCfg.prompt);
    let renderedForRead: string | null = null;
    let templateReadable = true;
    try {
      renderedForRead = renderPrompt(readFileSync(templatePath, 'utf-8'), repoRoot, flowName);
    } catch {
      // Template itself is gone/renamed. Keep pointing at it so the Read fails LOUDLY —
      // but the message below must not then blame "落盘失败", which would send the reader
      // hunting a disk problem instead of a missing stage file.
      templateReadable = false;
    }
    const materialized = renderedForRead
      ? materializeRenderedPrompt(repoRoot, flowName, state.current_stage, renderedForRead)
      : null;
    const stagePromptPath = materialized ?? templatePath;
    const lines: string[] = [
      `[ai-flow] 流程 '${flowName}' 恢复中，Stage '${state.current_stage}' 已提交，等待用户确认。`,
      ``,
      `Signal 已写入但用户尚未执行 approve。`,
      isTerminal
        ? `提醒用户检查 '${state.current_stage}' 的产物后执行：${flowName} approve（终端阶段，approve 后流程结束）`
        : `提醒用户检查 '${state.current_stage}' 的产物后执行：${flowName} approve`,
      ``,
      `⚠️ 本次注入**不含**本 stage 的提示词正文。开发者在 gate 上提出任何修改、` +
        `或你要做 approve 之后的收尾动作之前，**先 Read 这个文件**并照它执行：`,
      stagePromptPath,
      materialized
        // ⚠️ 不要在这里提 gate 协议：这条分支**有意**不注入它（signal 已写，「先写 signal」
        // 那条提醒在此刻自相矛盾——`gate-protocol.test.ts` 钉着这一点），副本里也没有。
        // 说它「随本次注入另给」是错的。
        ? `（这是引擎为你落盘的**渲染后**副本：路径占位符已展开、写盘文档长度纪律已在内。）`
        : templateReadable
          ? `⚠️ 上面给的是**模板原文**（渲染副本落盘失败）：里面的 \`{{flow_root}}\` / \`{{project_root}}\` ` +
            `**没有被展开**，用上面 \`[ai-flow:paths]\` 块里的真实路径代入，⛔ 别照字面写——` +
            `sh 会报错，但 Write 不会，它会建出一个字面名的目录、文件落在那里等于没写。`
          : `⛔ 本 stage 的提示词文件读不出来（可能被改名或删了）。上面那个路径 Read 会失败——` +
            `这不是磁盘问题，是 flow 定义与 active.json 里的 stage id 对不上。先把它修好，别凭记忆往下做。`,
      isTerminal
        ? `⛔ 终端 stage 的 approve 后动作只写在上面那份提示词里，引擎的流程完成消息不会重复它` +
          `（它只说「总结产出、建议下一步」）——不读就动手会静默漏掉。`
        : `⚠️ 在 gate 上改了上游产物时，从它派生的下游产物 / 视图必须跟着同步，` +
          `规则写在上面那份提示词与它路由到的 references 里，漏了不会有任何东西报错。`,
      ``,
      `如需修改，继续讨论，完成后重新写入 signal。`,
      isTerminal ? `不要擅自结束流程，等待开发者 approve。` : `不要开始下一阶段工作。`,
    ];
    // The stage prompt the model is about to Read off disk does NOT carry what the engine
    // normally appends at injection time: `renderPrompt()` adds writtenDocLengthNote() on
    // the injection path only. Editing docs on a gate is exactly when that length
    // discipline applies, so append it here as well. (gateProtocolNote is deliberately not
    // added — the lines above already say the signal is in and not to advance, which is
    // what that note would repeat.)
    return {
      // The materialized copy already carries writtenDocLengthNote (renderPrompt adds it).
      // Only the degraded template-pointer path needs it appended here.
      additionalContext:
        pathsPreamble + lines.join('\n') + (materialized ? '' : '\n' + writtenDocLengthNote()),
      systemMessage: statusLine,
    };
  }

  // S2: flow-complete signal at terminal stage (no gate) — self-heal
  if (isFlowComplete && !stageCfg.completion.gate) {
    await appendLog(repoRoot, flowName, session_id, `SESSION_SELF_HEAL_COMPLETE stage=${state.current_stage}`);
    const result = await advanceStage(repoRoot, flowName, session_id, pathsPreamble.length);
    return { additionalContext: pathsPreamble + result.additionalContext };
  }

  // S1 + none/script: self-heal advance
  if (isSignalValid && !isGatePending(signal, config, state.current_stage)) {
    await appendLog(repoRoot, flowName, session_id, `SESSION_SELF_HEAL_ADVANCE stage=${state.current_stage}`);
    const result = await advanceStage(repoRoot, flowName, session_id, pathsPreamble.length);
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
  // Same reason as in advance-stage: the host's inline limit applies to the assembled
  // `additionalContext` (preamble + framing + prompt), so the size check must see all of it.
  const assemble = (body: string) => pathsPreamble + [
    `[ai-flow] 流程 '${flowName}' 恢复中，当前处于 '${state.current_stage}'。`,
    ``,
    `════════════════════════════════`,
    body,
    `════════════════════════════════`,
    ``,
    `阶段完成后，将 'done' 写入 signal 文件触发推进（引擎自动计算下一步）。`,
  ].join('\n');
  // Built before the budget check, not after: a gated stage carries this note too, so its
  // length is part of what the host receives and must be measured with the wrapper.
  const gateNote = stageCfg.completion.gate ? '\n' + gateProtocolNote() : '';
  let promptContent = '';
  if (existsSync(promptPath)) {
    try {
      // Oversize prompts are NOT injected in truncated form — see `injectableStagePrompt`.
      promptContent = injectableStagePrompt(
        renderPrompt(readFileSync(promptPath, 'utf-8'), repoRoot, flowName),
        promptPath,
        assembledOverhead(assemble) + gateNote.length,
        (text) => materializeRenderedPrompt(repoRoot, flowName, state.current_stage, text)
      );
    } catch { /* non-fatal */ }
  }
  promptContent += gateNote;

  const statusLine = flowStatusLine({
    flowName,
    stageId: state.current_stage,
    flowId: state.flow_id,
    gatePending: false,
    recovered: true,
  });

  return { additionalContext: assemble(promptContent), systemMessage: statusLine };
  } catch (e) {
    try {
      await appendLog(repoRoot, flowName, session_id, `ERROR session: ${truncateError(e)}`);
    } catch { /* appendLog itself failed — nothing more to do */ }
    return null;
  }
}
