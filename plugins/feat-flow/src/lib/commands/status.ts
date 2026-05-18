import type { UserPromptInput, HookOutput, UserPromptOutput } from '../types.js';
import { readState, hasActiveFlow, paths } from '../state.js';

export async function handleStatus(input: UserPromptInput): Promise<HookOutput> {
  const { cwd } = input;

  if (!hasActiveFlow(cwd)) {
    const out: UserPromptOutput = {
      hookEventName: 'UserPromptSubmit',
      additionalContext:
        '当前没有进行中的工作流。\n\n使用 `feat-flow start <需求描述>` 开始。',
    };
    return { hookSpecificOutput: out };
  }

  const state = readState(cwd);
  if (!state) {
    const out: UserPromptOutput = {
      hookEventName: 'UserPromptSubmit',
      additionalContext:
        '工作流状态异常（marker 存在但 state.json 缺失）。\n\n运行 `feat-flow abort` 清理后重新开始。',
    };
    return { hookSpecificOutput: out };
  }

  const stageLabel = state.current_stage.replace('stage-', 'Stage ');
  const lines: string[] = [
    `**当前工作流**`,
    ``,
    `- Flow: \`${state.flow_id}\``,
    `- 阶段: **${stageLabel}**`,
    `- 需求: ${state.requirement}`,
  ];

  if (state.waiting_for_gate) {
    lines.push(
      ``,
      `⏳ 等待 GATE 审批（${state.gate_type === 'task' ? '任务级' : '阶段级'}）`,
      ``,
      `运行 \`feat-flow approve <token>\``,
      `Token 查看：\`! cat ${paths(cwd).gateToken}\``,
    );
  } else {
    lines.push(``, `下一步: ${state.expected_next}`);
  }

  if (state.context_warning.warned) {
    lines.push(
      ``,
      `> ⚠️ Context 已用 ${state.context_warning.warned_at_pct}%，建议完成当前任务后 \`/clear\`。`,
    );
  }

  const out: UserPromptOutput = {
    hookEventName: 'UserPromptSubmit',
    additionalContext: lines.join('\n'),
  };
  return { hookSpecificOutput: out };
}
