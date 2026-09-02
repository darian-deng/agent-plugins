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
const DEFAULT_WARN_AT_PCT = 50;
const DEFAULT_REWARN_DELTA_PCT = 5;

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
  // mis-report: crossing block_at_pct latches context_blocked on the shared flow
  // state, after which PreToolUse denies every write for the rest of the flow.
  // The upstream contract is that agent_id appears only inside a subagent; a
  // client that never sends it falls back to today's behavior, which is why this
  // branches on presence and not on any particular value.
  if (input.agent_id !== undefined) return null;

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

  const warning = state.context_warning;
  const warnAt = flowContextCfg?.warn_at_pct ?? DEFAULT_WARN_AT_PCT;
  const rewarnDelta = flowContextCfg?.rewarn_delta_pct ?? DEFAULT_REWARN_DELTA_PCT;
  const blockAt = flowContextCfg?.block_at_pct;

  // ─── Block threshold ───────────────────────────────────────────────────────
  if (blockAt !== undefined && pct >= blockAt) {
    const firstTime = !state.context_blocked;
    // Throttle. This branch used to return its full text on every sample, which
    // was survivable only while sampling was write-tool-only. With every tool
    // sampling, replaying it would fire 18–63 times per session (simulated against
    // the recorded pct series of three sessions). So: the full brief once, then one
    // line per further `rewarnDelta` percent. `warned_at_pct` cannot carry this —
    // it freezes when the block latches, by design, because pretool reports it as
    // the level the block happened at.
    const remindedAt = state.context_warning.block_reminded_at_pct ?? 0;
    if (!firstTime && pct < remindedAt + rewarnDelta) return null;

    const nowIso = new Date().toISOString();
    await patchActiveState(repoRoot, flowName, (cur) => ({
      context_blocked: true,
      context_warning: {
        warned: true,
        warned_at_pct: firstTime ? pct : cur.context_warning.warned_at_pct,
        warned_at: firstTime ? nowIso : cur.context_warning.warned_at,
        block_reminded_at_pct: pct,
      },
    }));
    await appendLog(
      repoRoot, flowName, session_id,
      `CONTEXT_BLOCK pct=${pct} threshold=${blockAt} ${firstTime ? 'first' : 'repeat'}`
    );

    if (!firstTime) {
      return {
        additionalContext:
          `[ai-flow] Context ${pct}%（已过 block 阈值 ${blockAt}%），收尾窗口在继续关闭。` +
          `已经在收尾就不用管这条，接着做完；还没开始就现在开始。`,
      };
    }

    const docsList = docsPaths.join('、') || '本 flow 自己的 docs 目录';
    return {
      additionalContext:
        `[ai-flow] Context 已达 ${pct}%（block 阈值 ${blockAt}%）。\n\n` +
        `**现在开始做本 session 的收尾，不是立刻停手。** 挑一个不撕裂工作的时机` +
        `（一票刚回合、一轮子代理刚回报完），把手上这一轮收干净再交班。\n\n` +
        `⚠️ **写权限只收窄了一半**：对代码的写会被拒，但**对 ${docsList} 的写仍然放行**，` +
        `正是为了让你能把交班落盘。⛔ 不要因为看到本条就认定「所有工具都不能用了」——` +
        `实测有过一次：某 session 撞线后自己判定写盘已被拒，把交接文档写进了 session 私有 scratchpad，` +
        `新 session 根本找不到；同时一条推翻既有裁定的正确性发现整个丢失。Bash 也没有被拦。\n\n` +
        `**/clear 会带走什么**：flow 状态和已 commit 的东西在磁盘上，活得下来；` +
        `**在飞子代理的回报活不下来**——它的 findings、真机待验项、安全自检，` +
        `从它留下的那笔 commit 里重建不出来。所以有子代理在飞时，优先等它回来，` +
        `或者先把它那棵树的状态摘进交接文档再走。\n\n` +
        `**交接里只写后来的 session 重建不出来的东西**：哪棵树/哪条车道在做哪票、` +
        `哪些子代理还在飞（在哪棵树上）、当前测试基线、以及你已经拍了但还没落盘的决策。\n\n` +
        `收尾做完后告知开发者可以 /clear。并且**现在**就向开发者输出一条醒目提醒` +
        `（用 > 引用块或加粗）："⚠️ Context 已达 ${pct}%，我开始做收尾交接，完成后你可以 /clear。"`,
    };
  }

  // ─── Warn threshold ────────────────────────────────────────────────────────
  if (pct < warnAt) return null;

  const prevPct = warning.warned_at_pct ?? 0;
  if (warning.warned && pct < prevPct + rewarnDelta) return null;

  // Carry `block_reminded_at_pct` through: a full object patch would drop it, and
  // if pct ever dips back under blockAt and climbs again the block branch would
  // lose its throttle baseline.
  await patchActiveState(repoRoot, flowName, (cur) => ({
    context_warning: {
      warned: true,
      warned_at_pct: pct,
      warned_at: new Date().toISOString(),
      block_reminded_at_pct: cur.context_warning.block_reminded_at_pct ?? null,
    },
  }));
  await appendLog(repoRoot, flowName, session_id, `CONTEXT_WARN pct=${pct} threshold=${warnAt}`);

  return {
    additionalContext:
      `[ai-flow] Context 当前 ${pct}%（warn 阈值 ${warnAt}%）。` +
      `请向开发者输出一条醒目提醒（用 > 引用块或加粗），内容：` +
      `"⚠️ Context 已达 ${pct}%。如需高质量执行，可 Ctrl+C 停止任务 → /clear → 重入后从断点继续（ai-flow 进度已持久化）。"` +
      `输出提醒后继续正常执行当前工作，不要中断或停止。`,
  };

  } catch (e) {
    try {
      await appendLog(repoRoot, flowName, session_id, `ERROR posttool tool=${tool_name}: ${truncateError(e)}`);
    } catch { /* appendLog itself failed */ }
    return null;
  }
}
