import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { SessionStartInput, HookOutput, SessionOutput } from './types.js';
import { readState, writeState, hasActiveFlow, paths } from './state.js';
import { contextSizeForModel, isUserScopeInstall, GLOBAL_SCOPE_ERROR } from './config.js';
import { STAGES_DIR, HELPER_PATH } from './config.js';

export async function handleSessionStart(input: SessionStartInput): Promise<HookOutput | null> {
  const { cwd, session_id, model } = input;

  if (!hasActiveFlow(cwd)) return null;

  const state = readState(cwd);
  if (!state) {
    const out: SessionOutput = {
      hookEventName: 'SessionStart',
      additionalContext:
        '[feat-flow 警告] .feat-flow-active marker 存在但 state.json 不存在。\n' +
        '请运行 feat-flow status 或 feat-flow abort 处理异常状态。',
    };
    return { hookSpecificOutput: out };
  }

  // Detect new session (after /clear or new window) → reset context warning
  const sessionChanged = state.last_session_id !== null && state.last_session_id !== session_id;
  let updatedState = { ...state };

  if (sessionChanged) {
    updatedState.context_warning = { warned: false, warned_at_pct: null, warned_at: null };
  }
  updatedState.last_session_id = session_id;

  // Update context_size if model provided
  if (model) {
    updatedState.context_size = contextSizeForModel(model);
  }

  writeState(cwd, updatedState);

  // Build context
  const lines: string[] = [];

  lines.push(
    `**feat-flow** 工作流恢复中`,
    ``,
    `- Flow: \`${state.flow_id}\``,
    `- 阶段: **${state.current_stage}**`,
  );

  if (state.waiting_for_gate) {
    // IMPORTANT: never inject the token value into additionalContext (AI-visible).
    // Token is only retrievable by the human via: ! cat .feat-flow/gate-token
    lines.push(
      ``,
      `⏳ 等待 GATE 审批（${state.gate_type === 'task' ? '任务级' : '阶段级'}）`,
      ``,
      `请等待用户执行：\`feat-flow approve <token>\``,
      `Token 查看：\`! cat ${paths(cwd).gateToken}\``,
    );
  } else {
    lines.push(``, `下一步: ${state.expected_next}`);
    const stageDoc = join(STAGES_DIR, `${state.current_stage}.md`);
    if (existsSync(stageDoc)) {
      lines.push('', '---', '', readFileSync(stageDoc, 'utf-8'));
    }
  }

  const out: SessionOutput = {
    hookEventName: 'SessionStart',
    additionalContext: lines.filter(Boolean).join('\n'),
  };
  return { hookSpecificOutput: out };
}
