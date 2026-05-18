import type { UserPromptInput, HookOutput, UserPromptOutput } from '../types.js';
import { runInit } from '../init-handler.js';

export async function handleInit(input: UserPromptInput): Promise<HookOutput> {
  const { cwd } = input;
  const result = await runInit(cwd);

  if (!result.ok) {
    const out: UserPromptOutput = {
      hookEventName: 'UserPromptSubmit',
      permissionDecision: 'deny',
      permissionDecisionReason: result.reason ?? 'feat-flow init 失败',
    };
    return { hookSpecificOutput: out };
  }

  const out: UserPromptOutput = {
    hookEventName: 'UserPromptSubmit',
    additionalContext: result.message ?? '✅ feat-flow 已初始化',
  };
  return { hookSpecificOutput: out };
}
