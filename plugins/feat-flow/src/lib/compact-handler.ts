import type { PreCompactInput, HookOutput, PreCompactOutput } from './types.js';
import { readState, hasActiveFlow } from './state.js';

export async function handlePreCompact(input: PreCompactInput): Promise<HookOutput | null> {
  const { cwd } = input;
  if (!hasActiveFlow(cwd)) return null;

  const state = readState(cwd);
  if (!state) return null;

  if (state.current_stage === 'stage-5') {
    const out: PreCompactOutput = { hookEventName: 'PreCompact' };
    return {
      systemMessage:
        `⚠️ feat-flow: stage-5（代码实施）进行中，禁止 compact 以保护上下文完整性。\n` +
        `flow_id: ${state.flow_id}\n` +
        `请完成当前 task 并更新 plan.md 的 checkbox 后再执行 compact。`,
      hookSpecificOutput: out,
    };
  }

  return null;
}
