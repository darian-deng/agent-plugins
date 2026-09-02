import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { loadFlowConfig } from '../flow-config-loader.js';
import { hasActiveFlow, writeActiveState, appendLog, materializeRenderedPrompt, type ActiveState } from '../state.js';
import { bindSession } from '../session-registry.js';
import { renderPrompt, buildAiFlowPreamble, gateProtocolNote, injectableStagePrompt, assembledOverhead, commandOutputPrefix } from '../prompt-render.js';
import { findPreflightCommand } from '../preflight.js';
import { runScript } from '../script-executor.js';
import { contextPct, DEFAULT_CONTEXT_WINDOW } from '../context.js';
import type { CommandResult } from '../types.js';

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

  let config;
  try {
    config = await loadFlowConfig(repoRoot, flowName);
  } catch (e: unknown) {
    return { action: 'deny', reason: String(e) };
  }

  const active = await hasActiveFlow(repoRoot);
  if (active) {
    // The cross-checkout case needs a different refusal. `hasActiveFlow` also resolves
    // a flow living in ANOTHER checkout of this repository (see `ResolvedFlow.viaSibling`),
    // and the generic wording below then suggested `<flow> abort` for a flow the developer
    // cannot see from where they stand — running it here would destroy that other
    // checkout's flow state. Name both ends and give the route that actually applies.
    //
    // Second line of defence, not the main path: a `start` typed at the prompt is already
    // refused upstream by handleUserPrompt's cross-checkout guard, which has the session's
    // real cwd to name. This branch covers every other caller of the exported handleStart —
    // its own contract admits a viaSibling result, so answering it correctly belongs here
    // rather than being assumed away.
    if (active.viaSibling) {
      return {
        action: 'deny',
        reason:
          `流程 '${active.flowName}' 正在运行，但它的**锚点在本仓库的另一个检出**：${active.repoRoot}
` +
          `（本次 start 的目标锚点是 ${repoRoot}）
` +
          `⛔ 不要在这里 abort 它——命令会作用在那个检出上。要停它就去它自己的检出里停。
` +
          `⇒ 想在本检出跑自己的 flow：先把它的流程状态挪走（代码一行不动），再重启本 session 上下文：
` +
          `     mv ${join(active.repoRoot, '.ai-flow', active.flowName, 'state')} ` +
          `${join(active.repoRoot, '.ai-flow', active.flowName, 'state')}.parked`,
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

  const preflightCmd = findPreflightCommand(join(repoRoot, '.ai-flow', flowName));
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
    context_warning: { warned: false, warned_at_pct: null, warned_at: null },
    context_blocked: false,
    first_prompt_handled: false,
  };

  await writeActiveState(repoRoot, flowName, state);
  // Bind this session to the anchor so hooks resolve the flow by session_id
  // (cwd-independent) even after the agent cd's away from the flow root.
  bindSession(sessionId, repoRoot, flowName);
  await appendLog(repoRoot, flowName, sessionId, `STARTED flow_id=${flowId} stage=${firstStage.id}`);

  const promptPath = join(repoRoot, '.ai-flow', flowName, firstStage.prompt);
  // Same budget contract as the advance / session-start injection points — see the note in
  // `resume.ts`. This path had no check at all either, and its wrapper carries the user's
  // own `requirement` text, which has no length bound.
  const assemble = (body: string) =>
    buildAiFlowPreamble(repoRoot, flowName) +
    `Flow '${flowName}' started!\n\n` +
    `flow_id: ${flowId}\nrequirement: ${requirement.trim()}\ncurrent_stage: ${firstStage.id}\n\n` +
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
