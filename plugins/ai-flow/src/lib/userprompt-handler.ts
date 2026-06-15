import { join } from 'path';
import { discoverFlows, loadFlowConfig } from './flow-config-loader.js';
import { flowStatusLine } from './format.js';
import { parseFlowCommand, VALID_COMMANDS, escapeRegex } from './commands/router.js';
import { handleStart } from './commands/start.js';
import { handleApprove } from './commands/approve.js';
import { handleAbort } from './commands/abort.js';
import { handleResume } from './commands/resume.js';
import { handleStatus } from './commands/status.js';
import { handleHelp } from './commands/help.js';
import { resolveActiveFlow, findRepoRoot, writeActiveState, readSignal, isGatePending, activeJsonPath, readActiveState } from './state.js';
import type { UserPromptInput, HookOutput, UserPromptOutput } from './types.js';

function makeOutput(additionalContext?: string, permissionDecision?: 'allow' | 'deny', reason?: string): HookOutput {
  const o: UserPromptOutput = {
    hookEventName: 'UserPromptSubmit',
    ...(permissionDecision && { permissionDecision }),
    ...(permissionDecision === 'deny' && reason && { permissionDecisionReason: reason }),
    ...(additionalContext !== undefined && { additionalContext }),
  };
  return { hookSpecificOutput: o };
}

function resultToHookOutput(result: { action: string; reason?: string; additionalContext?: string; systemMessage?: string }, flowName?: string): HookOutput {
  let additionalContext = result.additionalContext;
  if (result.action === 'allow' && additionalContext !== undefined && flowName) {
    additionalContext =
      `[ai-flow system] Hook intercepted this command for flow '${flowName}'. ` +
      `Do NOT invoke a skill named '${flowName}' — proceed directly with the instructions below.\n\n` +
      additionalContext;
  }
  const o: UserPromptOutput = {
    hookEventName: 'UserPromptSubmit',
    ...(result.action === 'deny' && {
      permissionDecision: 'deny',
      permissionDecisionReason: result.reason,
    }),
    ...(result.action === 'allow' && additionalContext !== undefined && {
      additionalContext,
    }),
  };
  return {
    ...(result.systemMessage && { systemMessage: result.systemMessage }),
    hookSpecificOutput: o,
  };
}

export async function handleUserPrompt(input: UserPromptInput): Promise<HookOutput> {
  const { cwd, prompt, session_id } = input;
  // Resolve the active flow by session binding first (cwd-independent), then
  // walk up from cwd. Active flow gives us repoRoot directly; otherwise walk up
  // to find .ai-flow (handles "no active flow yet" — e.g. a `<flow> start`).
  const active = await resolveActiveFlow(cwd, session_id).catch(() => null);
  const repoRoot = active?.repoRoot ?? findRepoRoot(cwd) ?? cwd;

  // ── Global session mutex guard ──────────────────────────────────────────────
  // If this session is not the owner of the active flow, deny ALL prompts
  // unconditionally. This is a protocol-level block: Claude never sees the
  // user's input; only the denial reason is shown.
  if (active && active.state.last_session_id && active.state.last_session_id !== session_id) {
    const ownerSession = active.state.last_session_id;
    const activeFile = activeJsonPath(active.repoRoot, active.flowName);
    return resultToHookOutput({
      action: 'deny',
      reason: [
        `⚠️ 当前 session 未持有 '${active.flowName}' 流程控制权（持有者：session ${ownerSession}）。`,
        ``,
        `为避免多 session 并发导致流程状态损坏，本 session 的所有输入均被拒绝。`,
        ``,
        `如需同时进行其他工作：使用 git worktree 创建独立工作空间后在新 session 中操作。`,
        `如认为持有者 session 已不存在（误报），恢复步骤（顺序不可颠倒）：`,
        `  1. 在编辑器中打开 ${activeFile}，将 "last_session_id" 改为 null 并保存。`,
        `  2. 保存完成后执行 /clear。`,
      ].join('\n'),
    });
  }
  // ───────────────────────────────────────────────────────────────────────────

  const knownFlows = await discoverFlows(repoRoot);
  const parsed = parseFlowCommand(prompt.trim(), knownFlows);

  if (!parsed) {
    // Layer 2: first-prompt resume guidance — inject once per session per active flow
    if (active && !(active.state.first_prompt_handled ?? false)) {
      // Gather gate info BEFORE writing first_prompt_handled, so a config load
      // failure doesn't cause us to mark handled with incomplete information.
      let gatePending = false;
      try {
        const config = await loadFlowConfig(active.repoRoot, active.flowName);
        const signal = readSignal(active.repoRoot, active.flowName);
        gatePending = isGatePending(signal, config, active.state.current_stage);
      } catch { /* non-fatal — guidance still injected without gate info */ }

      const updatedState = { ...active.state, first_prompt_handled: true };
      await writeActiveState(active.repoRoot, active.flowName, updatedState);

      const flowRoot = join(active.repoRoot, '.ai-flow', active.flowName);
      const statusLine = flowStatusLine({
        flowName: active.flowName,
        stageId: active.state.current_stage,
        flowId: active.state.flow_id,
        gatePending,
        recovered: false,
      });

      const guidance = [
        `[ai-flow:resume-guidance]`,
        `当前处于流程：${statusLine}`,
        ``,
        `你的第一句回复必须以如下一行状态开头，让开发者确认仍在流程内：`,
        `"${statusLine}"`,
        ``,
        `然后判断本条消息的意图，二选一：`,
        `· 若是「继续/推进当前阶段/approve/讨论当前 stage 产物」→ 按当前 stage 状态直接接续，不另起炉灶。`,
        `· 若是一个看起来独立的新任务 → 先读 ${flowRoot} 下 active.json、当前 stage 产物、references/、helper.md 掌握 flow 背景，判断它与当前 flow 的关系，再动手；全程保持 flow 约束（gate 待确认时勿擅自推进 stage，write_scope 限制仍生效）。`,
      ].join('\n');

      return makeOutput(guidance);
    }
    return makeOutput();
  }

  const { flowName, subCmd, args } = parsed;

  // Session ownership check: block non-owner sessions from issuing flow commands.
  // Read the target flow's state directly so the check works even when the command
  // targets a different flow than the one hasActiveFlow happened to return.
  const targetFlowState = await readActiveState(repoRoot, flowName).catch(() => null);
  if (targetFlowState?.last_session_id && targetFlowState.last_session_id !== session_id) {
    const ownerSession = targetFlowState.last_session_id;
    const activeFile = activeJsonPath(repoRoot, flowName);
    return resultToHookOutput({
      action: 'deny',
      reason: `[ai-flow] 流程 '${flowName}' 当前由 session '${ownerSession}' 控制，本 session 不可操作。\n` +
        `恢复步骤（误报时）：\n` +
        `  1. 在编辑器中打开 ${activeFile}，将 "last_session_id" 改为 null 并保存。\n` +
        `  2. 保存完成后，在本 session 执行 /clear。`,
    });
  }

  // non-command message: unknown subcommand
  if (!subCmd || !VALID_COMMANDS.includes(subCmd as typeof VALID_COMMANDS[number])) {
    if (!subCmd) {
      return resultToHookOutput(await handleHelp(repoRoot, flowName), flowName);
    }
    return makeOutput(
      `Unknown command '${subCmd}' for flow '${flowName}'.\nValid commands: ${VALID_COMMANDS.join(', ')}`,
    );
  }

  // Route command
  let result;
  switch (subCmd as typeof VALID_COMMANDS[number]) {
    case 'start': {
      const requirement = args || prompt.replace(new RegExp(`^${escapeRegex(flowName)}\\s+start\\s*`, 'i'), '').trim();
      result = await handleStart(repoRoot, flowName, requirement, session_id, 0, cwd, input.transcript_path);
      break;
    }
    case 'approve':
      result = await handleApprove(repoRoot, flowName, session_id, args);
      break;
    case 'abort':
      result = await handleAbort(repoRoot, flowName, session_id, args);
      break;
    case 'resume':
      result = await handleResume(repoRoot, flowName, session_id, args);
      break;
    case 'status':
      result = await handleStatus(repoRoot, flowName);
      break;
    case 'help':
      result = await handleHelp(repoRoot, flowName);
      break;
  }

  return resultToHookOutput(result!, flowName);
}
