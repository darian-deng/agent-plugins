import type { UserPromptInput, HookOutput, UserPromptOutput } from '../types.js';
import { readState, hasActiveFlow, readGateToken, paths } from '../state.js';

export async function handleStatus(input: UserPromptInput): Promise<HookOutput> {
  const { cwd } = input;

  if (!hasActiveFlow(cwd)) {
    const out: UserPromptOutput = {
      hookEventName: 'UserPromptSubmit',
      additionalContext: '无活跃的 feat-flow。\n运行 feat-flow start <需求描述> 开始新工作流。',
    };
    return { hookSpecificOutput: out };
  }

  const state = readState(cwd);
  if (!state) {
    const out: UserPromptOutput = {
      hookEventName: 'UserPromptSubmit',
      additionalContext: '有活跃 marker 但 state.json 不存在，flow 状态异常。\n建议运行 feat-flow abort。',
    };
    return { hookSpecificOutput: out };
  }

  const lines: string[] = [
    `feat-flow 状态`,
    `──────────────────────────────`,
    `flow_id:      ${state.flow_id}`,
    `需求:         ${state.requirement}`,
    `当前阶段:     ${state.current_stage}`,
    `base_sha:     ${state.base_sha}`,
    `开始时间:     ${state.started_at}`,
  ];

  if (state.waiting_for_gate) {
    lines.push(
      ``,
      `⏳ 等待 GATE 审批 (${state.gate_type})`,
      `gate_context: ${state.gate_context ?? ''}`,
      ``,
      `执行审批：feat-flow approve <token>`,
      `（token 请执行：! cat ${paths(cwd).gateToken}）`,
    );
  } else {
    lines.push(``, `期望下一步: ${state.expected_next}`);
  }

  if (state.context_warning.warned) {
    lines.push(
      ``,
      `⚠️ Context 已用 ${state.context_warning.warned_at_pct}%（建议 /clear 后继续）`,
    );
  }

  const out: UserPromptOutput = {
    hookEventName: 'UserPromptSubmit',
    additionalContext: lines.join('\n'),
  };
  return { hookSpecificOutput: out };
}
