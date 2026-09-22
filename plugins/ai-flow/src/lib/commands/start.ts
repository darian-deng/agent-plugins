import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { loadFlowConfig } from '../flow-config-loader.js';
import { hasActiveFlow, isForeignCheckout, writeActiveState, appendLog, materializeRenderedPrompt, type ActiveState } from '../state.js';
import { bindSession } from '../session-registry.js';
import { renderPrompt, buildAiFlowPreamble, gateProtocolNote, injectableStagePrompt, assembledOverhead, commandOutputPrefix, capInjectedText, REQUIREMENT_SOURCE } from '../prompt-render.js';
import { findPreflightCommand } from '../preflight.js';
import { runScript } from '../script-executor.js';
import { contextPct, DEFAULT_CONTEXT_WINDOW } from '../context.js';
import type { CommandResult } from '../types.js';
import { flowDefDir, stagePromptPath } from '../flow-paths.js';
import { pruneLegacyInstall } from '../legacy-cleanup.js';

const BLOCK_START_IF_ABOVE_PCT = 95;

function generateFlowId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${date}-${rand}`;
}

function isWorkingTreeDirty(repoRoot: string): boolean {
  try {
    const out = execSync('git status --porcelain', { cwd: repoRoot, encoding: 'utf-8' });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function getBaseSha(repoRoot: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

export async function handleStart(
  repoRoot: string,
  flowName: string,
  requirement: string,
  sessionId: string,
  contextSizePct: number,
  cwd?: string,
  transcriptPath?: string
): Promise<CommandResult> {
  if (!requirement.trim()) {
    return { action: 'deny', reason: `A requirement description is required. Usage: ${flowName} start <requirement>` };
  }

  // Use injected value (tests) or compute from transcript if not provided.
  // The transcript lives at the session's launch dir, not repoRoot — pass the
  // hook-provided transcript_path / real cwd so the read targets the right file.
  // If neither is available (cwd omitted), fall back to '' rather than repoRoot:
  // a wrong-dir guess silently mis-reads, whereas '' just misses the file and
  // yields 0 (no false context reading). Production always supplies cwd.
  const effectivePct = contextSizePct > 0
    ? contextSizePct
    : contextPct(sessionId, cwd ?? '', DEFAULT_CONTEXT_WINDOW, transcriptPath);
  if (effectivePct >= BLOCK_START_IF_ABOVE_PCT) {
    return {
      action: 'deny',
      reason: `Context is at ${effectivePct}%. Run /clear before starting a new flow to free up context space.`,
    };
  }

  // Second migration point. SessionStart's only fires when a flow is already
  // running, so a project that installed a flow and never started one would never
  // shed its legacy copies — and starting is exactly when the stale config.json
  // would do its damage, by pinning the new instance to the stage list that was
  // copied in at install time.
  try {
    pruneLegacyInstall(repoRoot, flowName);
  } catch { /* opportunistic: a failed migration must not block starting a flow */ }

  let config;
  try {
    config = await loadFlowConfig(repoRoot, flowName);
  } catch (e: unknown) {
    return { action: 'deny', reason: String(e) };
  }

  const resolved = await hasActiveFlow(repoRoot);
  // A flow resolved in an UNRELATED checkout of this repository does not block a start
  // here: that checkout is a working copy this flow never reads and never writes (see
  // `isForeignCheckout`), and every other hook already treats it as flow-less. Refusing
  // was the whole reason a developer with two hand-made worktrees could not start a flow
  // in the second one — the refusal's own way out ("park the other checkout's state")
  // asked them to disturb a running flow to get there. Only the flow's OWN ticket trees
  // keep the refusal below.
  const active = resolved && isForeignCheckout(resolved, cwd ?? repoRoot) ? null : resolved;
  if (active) {
    // Reaching `viaSibling` here means the caller sits in one of the flow's OWN ticket
    // worktrees (an unrelated checkout was filtered out above). The generic wording below
    // would suggest `<flow> abort`, which from a ticket tree destroys the state of the very
    // flow that opened it. Name the anchor and send the caller there instead.
    //
    // Second line of defence, not the main path: a `start` typed at the prompt is already
    // refused upstream by handleUserPrompt's ticket-tree guard, which has the session's
    // real cwd to name. This branch covers every other caller of the exported handleStart —
    // its own contract admits a viaSibling result, so answering it correctly belongs here
    // rather than being assumed away.
    if (active.viaSibling) {
      return {
        action: 'deny',
        reason:
          `流程 '${active.flowName}' 正在运行，而你现在在它给票开的**临时工作树**里：${repoRoot}
` +
          `（它的锚点是 ${active.repoRoot}）
` +
          `⛔ 不要在这里 abort 它——命令会作用到锚点上，销毁的正是打开这棵树的那条流程。
` +
          `⇒ 票树只通过 signal 文件参与流程，不在这里开新 flow；要操作它就回到 ${active.repoRoot}。`,
      };
    }
    return {
      action: 'deny',
      reason: `Flow '${active.flowName}' is already active. Run '${active.flowName} abort' before starting a new flow.`,
    };
  }

  if (isWorkingTreeDirty(repoRoot)) {
    return {
      action: 'deny',
      reason: 'Working tree has uncommitted changes. Run git stash or commit your changes before starting a flow.',
    };
  }

  const preflightCmd = findPreflightCommand(flowDefDir(repoRoot, flowName));
  if (preflightCmd) {
    const result = await runScript(preflightCmd, repoRoot);
    if (!result.ok) {
      return {
        action: 'deny',
        reason: `Preflight check failed:\n${result.reason}`,
      };
    }
  }

  const flowId = generateFlowId();
  const baseSha = getBaseSha(repoRoot);
  const firstStage = config.stages[0]!;

  const state: ActiveState = {
    flow_id: flowId,
    flow_name: flowName,
    requirement: requirement.trim(),
    current_stage: firstStage.id,
    base_sha: baseSha,
    started_at: new Date().toISOString(),
    last_session_id: sessionId,
    // Seed history with the creating session. SessionStart only appends when
    // last_session_id !== session_id (a takeover); the creating session already
    // owns last_session_id here, so without seeding it would never be recorded.
    history_session_ids: [sessionId],
    context_size: DEFAULT_CONTEXT_WINDOW,
    context_wrap_up: { at_pct: null },
    first_prompt_handled: false,
  };

  await writeActiveState(repoRoot, flowName, state);
  // Bind this session to the anchor so hooks resolve the flow by session_id
  // (cwd-independent) even after the agent cd's away from the flow root.
  bindSession(sessionId, repoRoot, flowName);
  await appendLog(repoRoot, flowName, sessionId, `STARTED flow_id=${flowId} stage=${firstStage.id}`);

  const promptPath = stagePromptPath(repoRoot, flowName, firstStage.prompt);
  // Same budget contract as the advance / session-start injection points — see the note in
  // `resume.ts`. Its wrapper carries the user's own `requirement` text, which has no length
  // bound, so it goes through `capInjectedText`: uncapped it is charged straight against the
  // stage prompt's budget. The full text stays on disk in `active.json` (written just above),
  // and the `[ai-flow:paths]` preamble hands the model `flow_root`.
  const assemble = (body: string) =>
    buildAiFlowPreamble(repoRoot, flowName) +
    `Flow '${flowName}' started!\n\n` +
    `flow_id: ${flowId}\nrequirement: ${capInjectedText(requirement, REQUIREMENT_SOURCE)}\ncurrent_stage: ${firstStage.id}\n\n` +
    body;
  const gateNote = firstStage.completion.gate ? '\n' + gateProtocolNote() : '';
  let stageContent = '';
  if (existsSync(promptPath)) {
    stageContent = injectableStagePrompt(
      renderPrompt(readFileSync(promptPath, 'utf-8'), repoRoot, flowName),
      promptPath,
      assembledOverhead(assemble) + gateNote.length + commandOutputPrefix(flowName).length,
      (text) => materializeRenderedPrompt(repoRoot, flowName, firstStage.id, text)
    );
  }
  stageContent += gateNote;

  return { action: 'allow', additionalContext: assemble(stageContent) };
}
