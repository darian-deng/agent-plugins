import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { UserPromptInput, HookOutput, UserPromptOutput } from '../types.js';
import { readState, writeState, readGateToken, removeGateToken, advanceStage, hasActiveFlow, appendTransition, paths } from '../state.js';
import { STAGES_DIR, HELPER_PATH } from '../config.js';

export async function handleApprove(input: UserPromptInput): Promise<HookOutput> {
  const { cwd, user_prompt } = input;

  const token = user_prompt.replace(/^feat-flow\s+approve\s*/i, '').trim();

  if (!hasActiveFlow(cwd)) {
    const out: UserPromptOutput = {
      hookEventName: 'UserPromptSubmit',
      permissionDecision: 'deny',
      permissionDecisionReason: '没有活跃的 feat-flow。先运行 feat-flow start <需求描述>。',
    };
    return { hookSpecificOutput: out };
  }

  const state = readState(cwd);
  if (!state) {
    const out: UserPromptOutput = {
      hookEventName: 'UserPromptSubmit',
      permissionDecision: 'deny',
      permissionDecisionReason: 'state.json 不存在，flow 状态异常。请运行 feat-flow abort。',
    };
    return { hookSpecificOutput: out };
  }

  if (!state.waiting_for_gate) {
    const out: UserPromptOutput = {
      hookEventName: 'UserPromptSubmit',
      permissionDecision: 'deny',
      permissionDecisionReason: `当前没有等待审批的 GATE。\n当前阶段：${state.current_stage}`,
    };
    return { hookSpecificOutput: out };
  }

  const storedToken = readGateToken(cwd);
  if (!storedToken || token !== storedToken) {
    const out: UserPromptOutput = {
      hookEventName: 'UserPromptSubmit',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `token 不匹配。\n\n如忘记 token，执行：! cat ${paths(cwd).gateToken}\n然后重新输入 feat-flow approve <token>`,
    };
    return { hookSpecificOutput: out };
  }

  // Safety check: unknown gate_type must NOT consume the token
  if (state.gate_type !== 'stage' && state.gate_type !== 'task') {
    const out: UserPromptOutput = {
      hookEventName: 'UserPromptSubmit',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `未知的 gate_type: ${state.gate_type}。state.json 可能已损坏。\n` +
        `请运行 feat-flow status 查看状态，或 feat-flow abort 安全终止。\ntoken 未被消耗。`,
    };
    return { hookSpecificOutput: out };
  }

  // Token valid — handle by gate type (remove token only after successful resolution)
  let nextState = { ...state };
  let contextLines: string[] = [];

  if (state.gate_type === 'stage') {
    nextState = advanceStage(state);
    appendTransition(cwd, `GATE_APPROVED stage=${state.current_stage} → ${nextState.current_stage}`);

    const nextDoc = join(STAGES_DIR, `${nextState.current_stage}.md`);
    let stageContent = '';
    if (existsSync(nextDoc)) {
      stageContent = '\n\n--- ' + nextState.current_stage + ' 指令 ---\n' + readFileSync(nextDoc, 'utf-8');
    }

    contextLines = [
      `✅ ${state.current_stage} 已审批，进入 ${nextState.current_stage}`,
      `如需了解工作流规则：${HELPER_PATH}`,
      stageContent,
    ];
  } else {
    // gate_type === 'task'
    const approvedGates = [...state.approved_task_gates, state.gate_context ?? ''];
    nextState = {
      ...state,
      waiting_for_gate: false,
      gate_type: null,
      gate_context: null,
      approved_task_gates: approvedGates,
      expected_next: '继续执行下一个 task',
    };
    appendTransition(cwd, `TASK_GATE_APPROVED context=${state.gate_context}`);

    contextLines = [
      `✅ 任务级 GATE 已审批：${state.gate_context}`,
      `继续执行 ${state.current_stage} 中的下一个 task。`,
      `如需了解工作流规则：${HELPER_PATH}`,
    ];
  }

  removeGateToken(cwd); // only consumed after successful gate resolution

  writeState(cwd, nextState);

  const out: UserPromptOutput = {
    hookEventName: 'UserPromptSubmit',
    additionalContext: contextLines.filter(Boolean).join('\n'),
  };
  return {
    systemMessage: `✅ GATE 审批成功 → ${nextState.current_stage}`,
    hookSpecificOutput: out,
  };
}
