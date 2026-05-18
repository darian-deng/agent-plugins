import type { UserPromptInput, HookOutput, UserPromptOutput } from '../types.js';
import { readState, hasActiveFlow, readGateToken, paths } from '../state.js';
import { HELP_TEXT } from './help.js';
import { handleStart } from './start.js';
import { handleApprove } from './approve.js';
import { handleAbort } from './abort.js';
import { handleResume } from './resume.js';
import { handleStatus } from './status.js';
import { HELPER_PATH, isGlobalInstall, GLOBAL_SCOPE_ERROR } from '../config.js';

const HELPER_REMINDER = `如需了解 feat-flow 工作流规则，参见：${HELPER_PATH}`;

function deny(reason: string): HookOutput {
  const out: UserPromptOutput = {
    hookEventName: 'UserPromptSubmit',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  };
  return { hookSpecificOutput: out };
}

function allow(additionalContext?: string, systemMessage?: string): HookOutput {
  const out: UserPromptOutput = {
    hookEventName: 'UserPromptSubmit',
    additionalContext,
  };
  return { systemMessage, hookSpecificOutput: out };
}

export async function handleUserPromptSubmit(input: UserPromptInput): Promise<HookOutput> {
  const { cwd, user_prompt } = input;
  const prompt = user_prompt.trim();

  // ── Global (user scope) install guard ─────────────────────────────────────
  if (isGlobalInstall() && (/^feat-flow\s/i.test(prompt) || prompt.toLowerCase() === 'feat-flow')) {
    return deny(GLOBAL_SCOPE_ERROR);
  }

  // ── feat-flow command routing ──────────────────────────────────────────────
  if (/^feat-flow\s/i.test(prompt) || prompt.toLowerCase() === 'feat-flow') {
    const subCmd = prompt.replace(/^feat-flow\s*/i, '').split(/\s/)[0]?.toLowerCase() ?? '';

    let result: HookOutput;

    switch (subCmd) {
      case 'start':
        result = await handleStart(input);
        break;
      case 'approve':
        result = await handleApprove(input);
        break;
      case 'abort':
        result = await handleAbort(input);
        break;
      case 'resume':
        result = await handleResume(input);
        break;
      case 'status':
        result = await handleStatus(input);
        break;
      case 'help':
      case '':
        result = allow(HELP_TEXT + '\n\n' + HELPER_REMINDER);
        break;
      default:
        result = deny(
          `未知命令：feat-flow ${subCmd}\n\n` + HELP_TEXT,
        );
        break;
    }

    // Append helper reminder to additionalContext for all feat-flow commands
    if (result.hookSpecificOutput && 'additionalContext' in result.hookSpecificOutput) {
      const existing = result.hookSpecificOutput.additionalContext ?? '';
      if (!existing.includes('helper.md')) {
        (result.hookSpecificOutput as UserPromptOutput).additionalContext =
          existing + (existing ? '\n\n' : '') + HELPER_REMINDER;
      }
    }

    return result;
  }

  // ── Non feat-flow messages — always pass through ──────────────────────────
  // GATE waiting does NOT block conversation. User may still talk to AI to
  // verify quality, then approve when ready (feat-flow approve <token>).
  return allow();
}
