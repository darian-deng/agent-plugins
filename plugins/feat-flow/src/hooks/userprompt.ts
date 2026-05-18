#!/usr/bin/env node
import { readFileSync } from 'fs';
import { handleUserPromptSubmit } from '../lib/commands/router.js';
import type { UserPromptInput, UserPromptOutput } from '../lib/types.js';

const raw = (() => { try { return readFileSync(0, 'utf-8'); } catch { return '{}'; } })();
const input = (() => { try { return JSON.parse(raw) as UserPromptInput; } catch { return {} as UserPromptInput; } })();

// Action commands need Claude to continue working after the hook response.
// Informational commands just need Claude to present output.
const ACTION_CMDS = new Set(['start', 'approve', 'abort', 'resume']);
const rawSubCmd = (input.prompt ?? '')
  .replace(/^feat-flow\s*/i, '').split(/\s/)[0]?.toLowerCase() ?? '';

try {
  const result = await handleUserPromptSubmit(input);
  if (!result) process.exit(0);

  const out = result.hookSpecificOutput as UserPromptOutput | undefined;

  // Hard deny: exit 2 + stderr (scope error, unknown command, validation failures).
  // Orange is appropriate — these ARE errors that need user attention.
  if (out?.permissionDecision === 'deny') {
    process.stderr.write((out.permissionDecisionReason ?? 'Blocked by feat-flow') + '\n');
    process.exit(2);
  }

  const { permissionDecision: _, permissionDecisionReason: __, ...cleanOut } = out ?? {};

  // Prefix additionalContext so Claude understands this command was fully handled
  // by the hook and should NOT be executed as a shell command.
  const ctx = 'additionalContext' in cleanOut ? cleanOut.additionalContext : undefined;
  if (ctx) {
    const cmd = (input.prompt ?? '').split('\n')[0]?.trim() ?? '';
    const actionNote = ACTION_CMDS.has(rawSubCmd)
      ? '工作流已更新，请按以下指示继续：'
      : '命令已由 hook 处理，以下是输出，直接展示给用户：';
    (cleanOut as { additionalContext: string }).additionalContext =
      `[feat-flow] \`${cmd}\` — ${actionNote}\n\n${ctx}`;
  }

  process.stdout.write(JSON.stringify({ ...result, hookSpecificOutput: cleanOut }));
} catch (e) {
  process.stderr.write(`[feat-flow userprompt error] ${String(e)}\n`);
}
