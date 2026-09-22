import { join, dirname } from 'path';
import { discoverFlows, loadFlowConfig, getStageConfig, resolveDocsPaths } from './flow-config-loader.js';
import { flowStatusLine } from './format.js';
import { flowDefDir } from './flow-paths.js';
import { commandOutputPrefix } from './prompt-render.js';
import { parseFlowCommand, VALID_COMMANDS, escapeRegex } from './commands/router.js';
import { handleStart } from './commands/start.js';
import { handleApprove } from './commands/approve.js';
import { handleAbort } from './commands/abort.js';
import { handleResume } from './commands/resume.js';
import { handleStatus } from './commands/status.js';
import { handleHelp } from './commands/help.js';
import { resolveActiveFlow, findRepoRoot, patchActiveState, readSignal, isGatePending, activeJsonPath, readActiveState, isForeignCheckout } from './state.js';
import type { UserPromptInput, HookOutput, UserPromptOutput } from './types.js';
import { readWatchdog, isLegacyCronTick, WATCHDOG_LABEL } from './watchdog.js';

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

  // A session in ANOTHER checkout of this repository is not part of that flow at all (see
  // `isForeignCheckout`), and unlike a non-owner it may hit this with `last_session_id`
  // already null — the owner's SessionEnd clears it. Resume guidance there would tell a
  // session working on an unrelated branch to report a flow status line and keep the
  // flow's constraints, and marking `first_prompt_handled` would mutate the other
  // checkout's active.json to say a prompt it never saw has been handled.
  const foreign = !!active && isForeignCheckout(active, cwd);

  // A foreign checkout routes its commands at ITS OWN anchor, never at the resolved
  // flow's. Taking `active.repoRoot` here was the bug behind "流程 X 当前由 session Y
  // 控制，本 session 不可操作" on a plain `<flow> start` in an unrelated worktree: the
  // ownership check below read the OTHER checkout's active.json, found a live owner,
  // and printed the take-over recipe ("set last_session_id to null, then /clear") —
  // which, followed, hijacks that other checkout's flow instead of starting one here.
  // Every other hook already treats a foreign checkout as flow-less (PreTool, PostTool,
  // Stop, SessionStart all bail on `isForeignCheckout`); command routing was the one
  // place still pointing at the neighbour.
  const repoRoot = (foreign ? null : active?.repoRoot) ?? findRepoRoot(cwd) ?? cwd;

  // A second session in the same repo (not the flow owner) is allowed to read /
  // search / answer questions: plain prompts pass through. It must NOT be nudged
  // into driving the flow, so we skip the resume-guidance below and never write to
  // the owner's active.json. Mutating flow commands stay blocked by the per-command
  // ownership check further down; project-file edits are blocked in PreToolUse.
  const isNonOwner = !!(active && active.state.last_session_id && active.state.last_session_id !== session_id);

  // A leftover 0.76.0 scheduled task. It is nobody's prompt — see `isLegacyCronTick`.
  //
  // Blocking it (0.78.0's answer) costs no tokens but never ENDS it: the cron keeps
  // firing every five minutes for the life of the session and survives `claude
  // --resume`, and the only tools that can delete it (`CronList` / `CronDelete`) belong
  // to the model, not to the developer the blocked prompt's text was shown to. So let
  // this one tick through with an instruction to delete the task — one turn, after
  // which the task is gone for good.
  if (isLegacyCronTick(prompt, input.source)) {
    return makeOutput([
      `${WATCHDOG_LABEL} 这条定时任务是 ai-flow 0.76.0 留下的，当前版本已经不用它了`,
      `（停滞自检改成了后台进程，不再走 cron）。它不是开发者说的话，也没有任何自检要做。`,
      ``,
      `现在就把它删掉，否则它会每 5 分钟再叫醒你一次、并且能撑过 \`claude --resume\`：`,
      `调用 CronList 找到 prompt 以 "${WATCHDOG_LABEL}" 开头的那条，用 CronDelete 删除。`,
      `删完回一行说删了哪条就结束回合——不要顺手做别的、不要复述流程状态。`,
    ].join('\n'));
  }

  // ── Stall watchdog ────────────────────────────────────────────────────────────
  // A prompt means a turn is starting AND that the developer is in the room. Both
  // matter to the watcher: `last_activity_at` is how it tells "a turn is running"
  // from "the session stopped and nobody came back", and the developer's presence is
  // what the nudge budget exists for — so spending it starts over from zero.
  if (active && !isNonOwner && !foreign) {
    await patchActiveState(active.repoRoot, active.flowName, (cur) => ({
      watchdog: {
        ...readWatchdog(cur),
        last_activity_at: new Date().toISOString(),
        // Unconditionally, not "if the entry-time read saw any spent": a watcher can
        // claim a nudge between this hook reading the state and taking the lock, and
        // that one would survive the developer's arrival.
        nudges_this_stage: 0,
      },
    }));
  }
  // ──────────────────────────────────────────────────────────────────────────────

  const knownFlows = await discoverFlows(repoRoot);
  const parsed = parseFlowCommand(prompt.trim(), knownFlows);

  if (!parsed) {
    // Layer 2: first-prompt resume guidance — inject once per session per active
    // flow. Skip entirely for a non-owner session: it must not be told to drive the
    // flow, and must not mutate the owner's active.json (first_prompt_handled).
    if (active && !isNonOwner && !foreign && !(active.state.first_prompt_handled ?? false)) {
      // Gather gate info BEFORE writing first_prompt_handled, so a config load
      // failure doesn't cause us to mark handled with incomplete information.
      let gatePending = false;
      // Where this flow's artifacts actually live, straight from the stage's own
      // `docs_paths`. Guessing it is not an option: it is per-flow and per-stage, and a
      // wrong path here is a silent Read failure in the one message meant to orient a
      // session that has no other background.
      let docsPaths: string[] = [];
      try {
        const config = await loadFlowConfig(active.repoRoot, active.flowName);
        const signal = readSignal(active.repoRoot, active.flowName);
        gatePending = isGatePending(signal, config, active.state.current_stage);
        docsPaths = resolveDocsPaths(
          getStageConfig(config, active.state.current_stage).docs_paths ?? [],
          active.state.flow_id
        );
      } catch { /* non-fatal — guidance still injected without gate info */ }

      await patchActiveState(active.repoRoot, active.flowName, { first_prompt_handled: true });

      // Three DIFFERENT roots, and this message used to send all three to the first one.
      // Since 0.69.0 the flow DEFINITION lives in the plugin, so `<project>/.ai-flow/<flow>/`
      // holds only `config.json` and `state/` — `references/` and `helper.md` are simply not
      // there, and the artifacts were never there. A session whose entire background is this
      // one injection was being pointed at two paths that do not exist and one that holds
      // nothing it needs; the Read fails, and nothing says why.
      const stateDir = join(active.repoRoot, '.ai-flow', active.flowName, 'state');
      const defDir = flowDefDir(active.repoRoot, active.flowName);
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
        `· 若是一个看起来独立的新任务 → 先掌握 flow 背景，再判断它与当前 flow 的关系，然后动手。`,
        `  背景按这个顺序取（三个目录不是一个，别互相代入）：`,
        `    1. ${join(defDir, 'helper.md')} — 流程总览：几个 stage、各自产出什么`,
        `    2. ${join(defDir, 'references')}/ — 各项纪律与契约（交接、修订、子代理边界）`,
        `    3. ${stateDir}/active.json — 当前 stage、flow_id、base_sha`,
        ...(docsPaths.length > 0
          ? [`    4. 本次产物（需求 / 方案 / 票面都在这儿，是「这件事当时定过吗」的答案所在）：`,
             ...docsPaths.map((d) => `       ${join(active.repoRoot, d)}`)]
          : [`    4. 本 stage 没配 docs_paths，产物落点问开发者，⛔ 别猜一个路径去 Read。`]),
        `  全程保持 flow 约束（gate 待确认时勿擅自推进 stage，write_scope 限制仍生效）。`,
      ].join('\n');

      return makeOutput(guidance);
    }
    return makeOutput();
  }

  const { flowName, subCmd, args } = parsed;

  // ── Ticket-tree guard for MUTATING commands ───────────────────────────────────
  // `active` came from the cross-checkout fallback, so `repoRoot` would be an anchor in
  // a DIFFERENT checkout of this repository than `cwd` (see `ResolvedFlow.viaSibling`).
  // Typing `abort` here would destroy the OTHER checkout's flow state — and until this
  // guard existed, `start`'s own refusal actively suggested it ("Run '<flow> abort'
  // before starting a new flow"), naming a flow the developer could not see from where
  // they stood.
  //
  // Reaching here means `cwd` is one of the flow's OWN ticket worktrees: a foreign
  // checkout (an unrelated developer worktree) already routes at its own anchor above
  // and never gets here, and the session DRIVING the flow is bound to the anchor
  // (session→anchor binding, resolved before walk-up and never tagged viaSibling), so an
  // owner keeps issuing commands even after `cd`-ing into a ticket tree. What is left is
  // a subagent — or a second session — inside a ticket tree, which participates in the
  // flow through the signal file, not through commands.
  //
  // Only the mutating four are refused. `status` / `help` are read-only, and their
  // output prints the anchor path, so the mismatch is visible there rather than acted on.
  //
  // It runs BEFORE the ownership check below, not after. After, it was unreachable in the
  // only state that matters: while a flow has ticket trees it also has a live owner, so
  // `approve` typed in a tree hit the ownership check first and got the take-over recipe
  // ("set last_session_id to null, then /clear") — which, followed, hijacks the very flow
  // that opened the tree. That is the outcome this guard exists to prevent.
  const MUTATING: readonly string[] = ['start', 'abort', 'approve', 'resume'];
  if (active?.viaSibling && !foreign && subCmd && MUTATING.includes(subCmd)) {
    return resultToHookOutput({
      action: 'deny',
      reason:
        `[ai-flow] 拒绝执行 '${flowName} ${subCmd}'：你现在在流程 '${active.flowName}' 给票开的` +
        `**临时工作树**里，流程锚点不在这儿，命令会作用到锚点那边而不是你当前目录。\n` +
        `    本 session 的 cwd：${cwd}\n` +
        `    流程锚点：        ${active.repoRoot}\n` +
        `票树只通过 signal 文件参与流程，不发流程命令。\n` +
        `⇒ 要操作 '${active.flowName}'（approve / abort / resume）→ 回到 ${active.repoRoot} 那个 session。`,
    });
  }
  // ──────────────────────────────────────────────────────────────────────────────

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
