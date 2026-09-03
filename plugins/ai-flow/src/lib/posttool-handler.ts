import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import type { PostToolInput } from './types.js';
import {
  resolveActiveFlow,
  patchActiveState,
  writeSignalFile,
  appendLog,
  signalPath,
  markBasePath,
  readSignal,
  nextStage,
} from './state.js';
import { truncateError } from './format.js';
import { contextPct, DEFAULT_CONTEXT_WINDOW } from './context.js';
import { loadFlowConfig, getStageConfig, resolveDocsPaths } from './flow-config-loader.js';
import { advanceStage } from './advance-stage.js';
import { buildAiFlowPreamble } from './prompt-render.js';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
// Occupancy at which a flow with no `wrap_up_at_pct` of its own starts wrapping up.
// 60 is not a fresh guess: it is the number both shipped flows carried as
// `block_at_pct`, so every install still holding the removed key — the schema drops
// it rather than rejecting it, see flow-schema.ts — keeps the timing it asked for.
const DEFAULT_WRAP_UP_AT_PCT = 60;

export async function handlePostTool(
  input: PostToolInput & { context_size_pct?: number }
): Promise<{ additionalContext: string } | null> {
  const { cwd, tool_name, session_id, context_size_pct } = input;

  // No write-tool gate here: context sampling below has to see every tool call.
  // Measuring only on Edit/Write missed the water mark almost entirely, because
  // a stage whose main session "only schedules" edits its docs through
  // `python3 <<'PY'` and `sed -i` under Bash. Observed across 14 sessions: Bash
  // carried 45–100% of the writes (three sessions did zero Edit/Write), and four
  // sessions peaked at 60–72.5% against a 60% block threshold with no warning
  // ever fired. The marker detection that follows stays write-only — see below.
  const active = await resolveActiveFlow(cwd, session_id).catch(() => null);
  if (!active) return null;

  const { flowName, state, repoRoot } = active;

  try {

  // ─── Control-plane markers: write tools only ───────────────────────────────
  // Signal and mark-base are recognised purely by comparing tool_input.file_path
  // against two fixed paths. Read carries a file_path too, and pretool's own deny
  // text tells the AI to `Read` the signal file / active.json — an engine-endorsed
  // path. So now that this handler runs for every tool, a plain *read* of either
  // marker would otherwise advance the stage, or capture base_sha_code early;
  // and because mark-base is first-writer-wins, an early capture makes the real
  // write a no-op ("already exists, skipping") and leaves Stage 4's diff base
  // permanently wrong. An empty fp matches neither absolute marker path.
  const rawFp = WRITE_TOOLS.has(tool_name)
    ? String((input.tool_input as Record<string, unknown>)?.['file_path'] ?? '')
    : '';
  const fp = rawFp === '' ? '' : (rawFp.startsWith('/') ? rawFp : join(repoRoot, rawFp));

  // ─── base_sha_code capture (mark-base marker) ───────────────────────────────
  // The AI writes the mark-base file right after committing the Stage 1-3 docs.
  // The engine then captures HEAD as base_sha_code (the diff base for Stages 5/6),
  // owning the active.json write so stages never touch active.json themselves.
  // git runs at repoRoot, so capture is cwd-independent.
  const markBase = markBasePath(repoRoot, flowName);
  if (fp === markBase) {
    try { if (existsSync(markBase)) unlinkSync(markBase); } catch { /* marker cleanup best-effort */ }
    let sha = '';
    try {
      sha = execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf-8' }).trim();
    } catch { /* not a git repo / no commits */ }
    if (!sha) {
      await appendLog(repoRoot, flowName, session_id, `BASE_CAPTURE_FAIL`);
      return { additionalContext: `[ai-flow] base_sha_code 捕获失败:无法 git rev-parse HEAD(仓库是否已有提交?)。请先完成 docs 提交再写 mark-base。` };
    }
    // First-writer-wins has to be decided against the state as it is at write
    // time, not against the copy read at hook entry: two markers written back to
    // back would both see it unset and the later HEAD would win.
    let alreadyCaptured: string | undefined;
    const written = await patchActiveState(repoRoot, flowName, (cur) => {
      alreadyCaptured = cur.base_sha_code;
      return alreadyCaptured ? {} : { base_sha_code: sha };
    });
    if (!written) {
      return { additionalContext: `[ai-flow] 流程已结束或已中止,base_sha_code 未写入。` };
    }
    if (alreadyCaptured) {
      return { additionalContext: `[ai-flow] base_sha_code 已存在(${alreadyCaptured}),跳过重复捕获。` };
    }
    await appendLog(repoRoot, flowName, session_id, `BASE_CAPTURED ${sha}`);
    return { additionalContext: `[ai-flow] ✓ base_sha_code 已捕获:${sha}(Stage 5/6 的代码 diff 基准,已写入引擎状态)。` };
  }

  const sig = signalPath(repoRoot, flowName);
  if (fp === sig) {
    // Signal file was just written — trigger only on the new 'done' keyword
    const signalContent = readSignal(repoRoot, flowName);
    if (signalContent === 'done') {
      const config = await loadFlowConfig(repoRoot, flowName);
      const stageCfg = getStageConfig(config, state.current_stage);
      const next = nextStage(config, state.current_stage);
      const normalizedSignal = next !== null ? next : 'flow-complete';

      if (stageCfg.completion.gate) {
        // Rewrite signal to the proper gate indicator for session recovery
        writeSignalFile(repoRoot, flowName, normalizedSignal);
        await appendLog(repoRoot, flowName, session_id, `POSTTOOL_GATE_PENDING stage=${state.current_stage}`);
        const isTerminal = next === null;
        return {
          additionalContext:
            `[ai-flow] Stage '${state.current_stage}' 已提交，等待人工确认。\n\n` +
            `向用户呈现本阶段的审查摘要：\n` +
            `- **本阶段若确定或改动了「第一目标 / 指导思想 / 明确不做的范围」，逐条原文列出**\n` +
            `  （只列本阶段落盘的，没有就写「本阶段未涉及」。⛔ 不许只说「已写进 xxx.md」——` +
            `埋在长文档里的目标，开发者在 gate 上批过、执行阶段才发现方向错，是这套流程最贵的一类返工）\n` +
            `- 具体交付了什么（引用实际产物，不要泛泛而谈）\n` +
            `- 做了哪些关键决策或权衡\n` +
            `- 有哪些需要用户特别注意的地方\n\n` +
            `最后告知用户：\n` +
            (isTerminal
              ? `  满意 → 执行 \`${flowName} approve\` 确认并结束流程\n` +
                `  需要调整 → 继续讨论，完成后重新触发\n\n` +
                `不要擅自结束流程，等待开发者 approve。`
              : `  满意 → 执行 \`${flowName} approve\` 进入下一阶段\n` +
                `  需要调整 → 继续讨论，完成后重新触发\n\n` +
                `不要开始下一阶段的任何工作。`),
        };
      }

      // none/script completion — advance immediately
      await appendLog(repoRoot, flowName, session_id, `POSTTOOL_SIGNAL_ADVANCE stage=${state.current_stage}`);
      // Built first so its length can be charged to the stage prompt's budget — this
      // preamble is part of what the host receives.
      const pathsPreamble = buildAiFlowPreamble(repoRoot, flowName, state.base_sha_code);
      const result = await advanceStage(repoRoot, flowName, session_id, pathsPreamble.length);
      return { additionalContext: pathsPreamble + result.additionalContext };
    }
    // Signal content is not 'done' — fall through to context monitoring
  }

  // ─── Context monitoring: main session only ─────────────────────────────────
  // A subagent runs on its own context window, so its token usage says nothing
  // about the main session's budget — delegating implementation to subagents is
  // precisely how a stage avoids spending it. Measuring it here would not only
  // mis-report: crossing wrap_up_at_pct latches `context_wrap_up.at_pct` on the
  // shared flow state, after which PreToolUse refuses every write to the codebase
  // for the rest of the flow.
  // The upstream contract is that agent_id appears only inside a subagent; a
  // client that never sends it falls back to today's behavior, which is why this
  // branches on presence and not on any particular value.
  if (input.agent_id !== undefined) return null;

  // Same reason, second axis: only the session that OWNS the flow may move its
  // context state. `active.json` is shared by every session in the checkout, so a
  // read-only session (one that found the flow already held — session-handler.ts
  // returns early for those) would otherwise latch the wrap-up at ITS occupancy.
  // Observed: a second session at 77% latched the owner's flow, the owner — who had
  // never crossed anything and never saw the brief — got `Context wrap-up started at
  // 77%` on its next edit, and could not clear it either, because the read-only
  // session's SessionStart returns before the reset on line below. Only `/clear` got
  // out of it, at the cost of whatever was not on disk.
  if (state.last_session_id !== null && state.last_session_id !== session_id) return null;

  // Load flow config for the per-flow context thresholds, and for the docs paths
  // the wrap-up brief has to name (pretool keeps writes to them open precisely so
  // a handoff can still land — the brief is useless if it can't say where).
  let flowContextCfg: Awaited<ReturnType<typeof loadFlowConfig>>['context'] | undefined;
  let docsPaths: string[] = [];
  try {
    const config = await loadFlowConfig(repoRoot, flowName);
    flowContextCfg = config.context;
    docsPaths = resolveDocsPaths(getStageConfig(config, state.current_stage).docs_paths ?? [], state.flow_id);
  } catch { /* non-fatal: fall back to defaults */ }

  // Use injected value (tests / future hook support) or compute from transcript.
  const contextWindow = state.context_size > 0 ? state.context_size : DEFAULT_CONTEXT_WINDOW;
  // Read the transcript by its real location: prefer the hook-provided
  // transcript_path; fall back to the session's launch cwd (NOT repoRoot — the
  // anchor isn't where the transcript lives in a monorepo sub-project).
  const pct = context_size_pct ?? contextPct(session_id, cwd, contextWindow, input.transcript_path);

  const wrapUp = state.context_wrap_up;
  const wrapUpAt = flowContextCfg?.wrap_up_at_pct ?? DEFAULT_WRAP_UP_AT_PCT;

  // ─── Wrap-up threshold ─────────────────────────────────────────────────────
  // One level, not two. The old warn tier fired ten points early with nothing
  // behind it — a suggestion to "Ctrl+C 停止任务 → /clear" at a moment when
  // nothing had been wrapped up yet, so acting on it lost work — and the repeat
  // throttle it came with (`rewarn_delta_pct`, since removed) re-stated it on
  // every percent of the way to the block (observed 50→60, ten times in one
  // desktop session). What remains is the level that actually does something:
  // pretool refuses writes to the codebase from
  // here on while keeping this flow's own docs_paths open, so crossing it *is*
  // "start wrapping up", not just a nudge. On a stage that declares no docs_paths
  // there is nothing to keep open, so pretool refuses nothing and this brief is all
  // the wrap-up there is — which is why the text below branches on that instead of
  // naming a docs directory the config never granted.
  if (pct < wrapUpAt) return null;

  // Once, at the crossing, and never again. Sampling runs on EVERY tool call, so
  // anything that fires more than once fires 18–63 times per session (simulated
  // against three recorded pct series) — and a repeat carries no new information:
  //  1. The latch is persistent. `context_wrap_up.at_pct` stays non-null for the
  //     rest of the flow (only a new session / `/clear` clears it), so the state
  //     "already wrapping up" does not need re-injection to stay true.
  //  2. The refusal is the standing reminder. Every attempt to write code hits
  //     pretool-handler's denial, whose text already says the wrap-up has started,
  //     that docs_paths remain writable, and what belongs in the handoff.
  //  3. Repeats measured out as pure noise: at threshold 60 with the old
  //     `rewarn_delta_pct: 1`, 60→99 meant up to 39 restatements — the 50→60
  //     ten-times-in-one-session observation above is the same failure one tier up.
  if (wrapUp.at_pct !== null) return null;

  // Both the freeze AND the decision to inject are made against the state as it is
  // at WRITE time, not the copy read at hook entry. PostToolUse fires once per tool
  // call and the model issues tool calls in parallel, so two samples really are in
  // flight together; the entry-read check above would let both through and the brief
  // (~1.4 KB) would land twice, with two `first` lines in flow.log. Same shape, same
  // fix as the mark-base branch further up.
  let alreadyLatched = false;
  await patchActiveState(repoRoot, flowName, (cur) => {
    alreadyLatched = cur.context_wrap_up.at_pct !== null;
    return alreadyLatched ? {} : { context_wrap_up: { at_pct: pct } };
  });
  if (alreadyLatched) return null;
  await appendLog(
    repoRoot, flowName, session_id,
    `CONTEXT_WRAP_UP pct=${pct} threshold=${wrapUpAt} first`
  );

  // The brief may only promise what pretool actually keeps open. `docs_paths` is
  // optional on an `unrestricted` stage (flow-schema.ts requires it only for
  // `docs_only`), and on a stage that declares none there is no escape hatch to
  // name — so pretool refuses nothing there, and this text must not say the
  // codebase is fenced either. The earlier fallback string ("本 flow 自己的 docs
  // 目录") did exactly that: it named a directory that did not exist in the config,
  // while the very next write to it was denied.
  const hasEscape = docsPaths.length > 0;
  const docsList = docsPaths.join('、');
  // Where the handoff goes. With no configured docs the model has to pick a spot in
  // the repo and say which — anywhere but the session-private scratchpad, which a
  // later session cannot find.
  const landing = hasEscape
    ? docsList
    : `仓库里的交接文档（本 stage 没有配 docs_paths，自己选一个与需求相关的文档落盘，并在告知开发者时说清落点）`;

  return {
    additionalContext:
      `[ai-flow] Context 已达 ${pct}%（收尾阈值 ${wrapUpAt}%）。\n\n` +
      `**现在开始为 /clear 做收尾，不是立刻停手。** 挑一个不撕裂工作的时机` +
      `（一票刚回合、一轮子代理刚回报完），把手上这一轮收干净再交班。\n\n` +
      (hasEscape
        ? `⚠️ **写权限只收窄了一半**：从现在起对代码的写会被拒，但**对 ${docsList} 的写仍然放行**，` +
          `正是为了让你能把交班落盘。⛔ 不要因为看到本条就认定「所有工具都不能用了」——` +
          `实测有过一次：某 session 撞线后自己判定写盘已被拒，把交接文档写进了 session 私有 scratchpad，` +
          `新 session 根本找不到；同时一条推翻既有裁定的正确性发现整个丢失。Bash 也没有被拦。\n\n`
        : `⚠️ **写权限没有收窄**：本 stage（${state.current_stage}）没有配 docs_paths，` +
          `引擎因此一个写入都没有拒——拒了就等于连交班都写不进去。收尾照旧要做，只是没有任何机械约束` +
          `帮你停下继续产出。⛔ 交接不要写进 session 私有 scratchpad：实测有过一次，新 session 根本找不到，` +
          `同时一条推翻既有裁定的正确性发现整个丢失。**顺带告诉开发者**：给这个 stage 配上 docs_paths` +
          `（走 /ai-flow:update），引擎才能在撞线后拦住对代码的继续产出。\n\n`) +
      `**/clear 会带走什么**：flow 状态和已 commit 的东西在磁盘上，活得下来，重入后从断点继续；` +
      `**在飞子代理的回报活不下来**——它的 findings、真机待验项、安全自检，` +
      `从它留下的那笔 commit 里重建不出来。所以有子代理在飞时，优先等它回来，` +
      `或者先把它那棵树的状态摘进交接文档再走。\n\n` +
      `**往 ${landing} 里只写后来的 session 重建不出来的东西**：哪棵树/哪条车道在做哪票、` +
      `哪些子代理还在飞（在哪棵树上）、当前测试基线、以及你已经拍了但还没落盘的决策。\n\n` +
      `收尾做完后告知开发者可以 /clear。并且**现在**就向开发者输出一条醒目提醒` +
      `（用 > 引用块或加粗）："⚠️ Context 已达 ${pct}%，我开始做收尾交接，完成后你可以 /clear。"`,
  };

  } catch (e) {
    try {
      await appendLog(repoRoot, flowName, session_id, `ERROR posttool tool=${tool_name}: ${truncateError(e)}`);
    } catch { /* appendLog itself failed */ }
    return null;
  }
}
