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
import { loadFlowConfig, getStageConfig } from './flow-config-loader.js';
import { advanceStage } from './advance-stage.js';
import { buildAiFlowPreamble } from './prompt-render.js';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const DEFAULT_WARN_AT_PCT = 50;
const DEFAULT_REWARN_DELTA_PCT = 5;

export async function handlePostTool(
  input: PostToolInput & { context_size_pct?: number }
): Promise<{ additionalContext: string } | null> {
  const { cwd, tool_name, session_id, context_size_pct } = input;

  if (!WRITE_TOOLS.has(tool_name)) return null;
  const active = await resolveActiveFlow(cwd, session_id).catch(() => null);
  if (!active) return null;

  const { flowName, state, repoRoot } = active;

  try {

  // ─── Signal detection ──────────────────────────────────────────────────────
  const rawFp = String((input.tool_input as Record<string, unknown>)?.['file_path'] ?? '');
  const fp = rawFp.startsWith('/') ? rawFp : join(repoRoot, rawFp);

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

  // Load flow config to get per-flow context thresholds.
  let flowContextCfg: Awaited<ReturnType<typeof loadFlowConfig>>['context'] | undefined;
  try {
    const config = await loadFlowConfig(repoRoot, flowName);
    flowContextCfg = config.context;
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
    if (!state.context_blocked) {
      await patchActiveState(repoRoot, flowName, {
        context_blocked: true,
        context_warning: { warned: true, warned_at_pct: pct, warned_at: new Date().toISOString() },
      });
    }
    return {
      additionalContext:
        `[ai-flow] Context 已达 ${pct}%（block 阈值 ${blockAt}%）。` +
        `后续所有 write 工具将被自动拒绝（context 保护已激活），不要再尝试任何工具调用。` +
        `请立即停止当前工作，向开发者说明原因：context 已超过 block 阈值，请运行 /clear 后重入继续（ai-flow 进度已持久化）。`,
    };
  }

  // ─── Warn threshold ────────────────────────────────────────────────────────
  if (pct < warnAt) return null;

  const prevPct = warning.warned_at_pct ?? 0;
  if (warning.warned && pct < prevPct + rewarnDelta) return null;

  await patchActiveState(repoRoot, flowName, {
    context_warning: { warned: true, warned_at_pct: pct, warned_at: new Date().toISOString() },
  });

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
