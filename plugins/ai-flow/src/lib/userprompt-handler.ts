import { discoverFlows } from './flow-config-loader.js';
import { isGateActive, deleteGateToken } from './state.js';
import { parseFlowCommand, VALID_COMMANDS, escapeRegex } from './commands/router.js';
import { handleStart } from './commands/start.js';
import { handleApprove } from './commands/approve.js';
import { handleAbort } from './commands/abort.js';
import { handleResume } from './commands/resume.js';
import { handleStatus } from './commands/status.js';
import { handleHelp } from './commands/help.js';
import type { UserPromptInput, HookOutput, UserPromptOutput } from './types.js';

function makeOutput(additionalContext?: string, permissionDecision?: 'allow' | 'deny', reason?: string): HookOutput {
  const o: UserPromptOutput = {
    hookEventName: 'UserPromptSubmit',
    ...(permissionDecision && { permissionDecision }),
    ...(permissionDecision === 'deny' && reason && { permissionDecisionReason: reason }),
    ...(additionalContext !== undefined && { additionalContext }),
  };
  return { hookSpecificOutput: o };
}

function resultToHookOutput(result: { action: string; reason?: string; additionalContext?: string; systemMessage?: string }, flowName?: string): HookOutput {
  let additionalContext = result.additionalContext;
  if (result.action === 'allow' && additionalContext !== undefined && flowName) {
    additionalContext =
      `[ai-flow system] Hook intercepted this command for flow '${flowName}'. ` +
      `Do NOT invoke a skill named '${flowName}' — proceed directly with the instructions below.\n\n` +
      additionalContext;
  }
  const o: UserPromptOutput = {
    hookEventName: 'UserPromptSubmit',
    ...(result.action === 'deny' && {
      permissionDecision: 'deny',
      permissionDecisionReason: result.reason,
    }),
    ...(result.action === 'allow' && additionalContext !== undefined && {
      additionalContext,
    }),
  };
  return {
    ...(result.systemMessage && { systemMessage: result.systemMessage }),
    hookSpecificOutput: o,
  };
}

export async function handleUserPrompt(input: UserPromptInput): Promise<HookOutput> {
  const { cwd, prompt, session_id } = input;
  const repoRoot = cwd;

  const knownFlows = await discoverFlows(repoRoot);
  const parsed = parseFlowCommand(prompt.trim(), knownFlows);

  if (!parsed) {
    // Check if any active flow has a gate that should be cleared by non-command messages
    for (const flowName of knownFlows) {
      if (await isGateActive(repoRoot, flowName)) {
        await deleteGateToken(repoRoot, flowName);
      }
    }
    return makeOutput();
  }

  const { flowName, subCmd, args } = parsed;

  // non-command message check for active gates
  if (!subCmd || !VALID_COMMANDS.includes(subCmd as typeof VALID_COMMANDS[number])) {
    if (await isGateActive(repoRoot, flowName)) {
      await deleteGateToken(repoRoot, flowName);
    }
    if (!subCmd) {
      return resultToHookOutput(await handleHelp(repoRoot, flowName), flowName);
    }
    return makeOutput(
      `Unknown command '${subCmd}' for flow '${flowName}'.\nValid commands: ${VALID_COMMANDS.join(', ')}`,
    );
  }

  // Route command
  let result;
  switch (subCmd as typeof VALID_COMMANDS[number]) {
    case 'start': {
      const requirement = args || prompt.replace(new RegExp(`^${escapeRegex(flowName)}\\s+start\\s*`, 'i'), '').trim();
      result = await handleStart(repoRoot, flowName, requirement, session_id, 0);
      break;
    }
    case 'approve':
      result = await handleApprove(repoRoot, flowName, args);
      break;
    case 'abort':
      result = await handleAbort(repoRoot, flowName, args);
      break;
    case 'resume':
      result = await handleResume(repoRoot, flowName, args);
      break;
    case 'status':
      result = await handleStatus(repoRoot, flowName);
      break;
    case 'help':
      result = await handleHelp(repoRoot, flowName);
      break;
  }

  return resultToHookOutput(result!, flowName);
}
