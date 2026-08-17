import { join } from 'path';
import { discoverFlows, loadFlowConfig } from './flow-config-loader.js';
import { flowStatusLine } from './format.js';
import { commandOutputPrefix } from './prompt-render.js';
import { parseFlowCommand, VALID_COMMANDS, escapeRegex } from './commands/router.js';
import { handleStart } from './commands/start.js';
import { handleApprove } from './commands/approve.js';
import { handleAbort } from './commands/abort.js';
import { handleResume } from './commands/resume.js';
import { handleStatus } from './commands/status.js';
import { handleHelp } from './commands/help.js';
import { resolveActiveFlow, findRepoRoot, patchActiveState, readSignal, isGatePending, activeJsonPath, readActiveState } from './state.js';
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
    // Same string the commands measure against the injection budget — see `commandOutputPrefix`.
    additionalContext = commandOutputPrefix(flowName) + additionalContext;
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

  // A second session in the same repo (not the flow owner) is allowed to read /
  // search / answer questions: plain prompts pass through. It must NOT be nudged
  // into driving the flow, so we skip the resume-guidance below and never write to
  // the owner's active.json. Mutating flow commands stay blocked by the per-command
  // ownership check further down; project-file edits are blocked in PreToolUse.
  const isNonOwner = !!(active && active.state.last_session_id && active.state.last_session_id !== session_id);

  const knownFlows = await discoverFlows(repoRoot);
  const parsed = parseFlowCommand(prompt.trim(), knownFlows);

  if (!parsed) {
    // Layer 2: first-prompt resume guidance — inject once per session per active
    // flow. Skip entirely for a non-owner session: it must not be told to drive the
    // flow, and must not mutate the owner's active.json (first_prompt_handled).
    if (active && !isNonOwner && !(active.state.first_prompt_handled ?? false)) {
      // Gather gate info BEFORE writing first_prompt_handled, so a config load
      // failure doesn't cause us to mark handled with incomplete information.
      let gatePending = false;
      try {
        const config = await loadFlowConfig(active.repoRoot, active.flowName);
        const signal = readSignal(active.repoRoot, active.flowName);
        gatePending = isGatePending(signal, config, active.state.current_stage);
      } catch { /* non-fatal — guidance still injected without gate info */ }

      await patchActiveState(active.repoRoot, active.flowName, { first_prompt_handled: true });

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
