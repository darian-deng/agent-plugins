import type { UserPromptInput, HookOutput, UserPromptOutput } from '../types.js';
import { isInitDone } from '../state.js';
import { HELP_TEXT } from './help.js';
import { handleInit } from './init.js';
import { handleStart } from './start.js';
import { handleApprove } from './approve.js';
import { handleAbort } from './abort.js';
import { handleResume } from './resume.js';
import { handleStatus } from './status.js';

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
    ...(additionalContext !== undefined && { additionalContext }),
  };
  return {
    ...(systemMessage !== undefined && { systemMessage }),
    hookSpecificOutput: out,
  };
}

export async function handleUserPromptSubmit(input: UserPromptInput): Promise<HookOutput> {
  const { cwd } = input;
  const prompt = input.prompt.trim();

  if (!/^feat-flow/i.test(prompt)) {
    // Non feat-flow messages always pass through
    return allow();
  }

  const subCmd = prompt.replace(/^feat-flow\s*/i, '').split(/\s/)[0]?.toLowerCase() ?? '';

  // ── init command — always allowed, never auto-init before it ───────────────
  if (subCmd === 'init') {
    return handleInit(input);
  }

  // ── auto-init: run init silently if this project hasn't been initialised ───
  if (!isInitDone(cwd)) {
    const initResult = await handleInit(input);
    // If init itself failed (scope wrong, no Node, no git), surface that error
    const initOut = initResult.hookSpecificOutput as { permissionDecision?: string } | undefined;
    if (initOut?.permissionDecision === 'deny') {
      return initResult;
    }
    // Init succeeded — fall through to the original command
  }

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
      result = allow(HELP_TEXT);
      break;
    default:
      result = deny(`未知命令：feat-flow ${subCmd}\n\n可用命令：init | start | approve | abort | resume | status | help`);
      break;
  }

  return result;
}
