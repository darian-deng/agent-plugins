import { readFileSync } from 'fs';
import { join } from 'path';
import type { PostToolInput } from './types.js';
import {
  hasActiveFlow,
  writeActiveState,
  writeSignalFile,
  appendLog,
  signalPath,
  readSignal,
  nextStage,
} from './state.js';
import { truncateError } from './format.js';
import { contextPct, DEFAULT_CONTEXT_WINDOW } from './context.js';
import { loadFlowConfig, getStageConfig } from './flow-config-loader.js';
import { advanceStage } from './advance-stage.js';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const DEFAULT_WARN_AT_PCT = 50;
const DEFAULT_REWARN_DELTA_PCT = 5;

export async function handlePostTool(
  input: PostToolInput & { context_size_pct?: number }
): Promise<{ additionalContext: string } | null> {
  const { cwd, tool_name, session_id, context_size_pct } = input;

  if (!WRITE_TOOLS.has(tool_name)) return null;
  const active = await hasActiveFlow(cwd).catch(() => null);
  if (!active) return null;

  const { flowName, state, repoRoot } = active;

  try {

  // ─── Signal detection ──────────────────────────────────────────────────────
  const rawFp = String((input.tool_input as Record<string, unknown>)?.['file_path'] ?? '');
  const fp = rawFp.startsWith('/') ? rawFp : join(repoRoot, rawFp);
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
      const result = await advanceStage(repoRoot, flowName, session_id);
      const flowRoot = join(repoRoot, '.ai-flow', flowName);
      const pathsPreamble = `[ai-flow:paths]\nproject_root: ${repoRoot}\nflow_root: ${flowRoot}\n\n`;
      return { additionalContext: pathsPreamble + result.additionalContext };
    }
    // Signal content is not 'done' — fall through to context monitoring
  }

  // Load flow config to get per-flow context thresholds.
  let flowContextCfg: Awaited<ReturnType<typeof loadFlowConfig>>['context'] | undefined;
  try {
    const config = await loadFlowConfig(repoRoot, flowName);
    flowContextCfg = config.context;
  } catch { /* non-fatal: fall back to defaults */ }

  // Use injected value (tests / future hook support) or compute from transcript.
  const contextWindow = state.context_size > 0 ? state.context_size : DEFAULT_CONTEXT_WINDOW;
  const pct = context_size_pct ?? contextPct(session_id, repoRoot, contextWindow);

  const warning = state.context_warning;
  const warnAt = flowContextCfg?.warn_at_pct ?? DEFAULT_WARN_AT_PCT;
  const rewarnDelta = flowContextCfg?.rewarn_delta_pct ?? DEFAULT_REWARN_DELTA_PCT;
  const blockAt = flowContextCfg?.block_at_pct;

  // ─── Block threshold ───────────────────────────────────────────────────────
  if (blockAt !== undefined && pct >= blockAt) {
    if (!state.context_blocked) {
      const updated = {
        ...state,
        context_blocked: true,
        context_warning: { warned: true, warned_at_pct: pct, warned_at: new Date().toISOString() },
      };
      await writeActiveState(repoRoot, flowName, updated);
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

  const updated = {
    ...state,
    context_warning: { warned: true, warned_at_pct: pct, warned_at: new Date().toISOString() },
  };
  await writeActiveState(repoRoot, flowName, updated);

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
