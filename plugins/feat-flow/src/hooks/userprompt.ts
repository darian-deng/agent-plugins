#!/usr/bin/env node
import { readFileSync } from 'fs';
import { handleUserPromptSubmit } from '../lib/commands/router.js';
import type { UserPromptInput, UserPromptOutput } from '../lib/types.js';

const raw = (() => { try { return readFileSync(0, 'utf-8'); } catch { return '{}'; } })();
const input = (() => { try { return JSON.parse(raw) as UserPromptInput; } catch { return {} as UserPromptInput; } })();

try {
  const result = await handleUserPromptSubmit(input);
  if (!result) process.exit(0);

  const out = result.hookSpecificOutput as UserPromptOutput | undefined;

  // Hard deny (scope error, unknown command, validation failures):
  // exit 2 + stderr — orange is appropriate here, these ARE errors.
  if (out?.permissionDecision === 'deny') {
    process.stderr.write((out.permissionDecisionReason ?? 'Blocked by feat-flow') + '\n');
    process.exit(2);
  }

  // All other responses (informational and action commands):
  // Use additionalContext — output is rendered by Claude as clean white text.
  const { permissionDecision: _, permissionDecisionReason: __, ...cleanOut } = out ?? {};
  process.stdout.write(JSON.stringify({ ...result, hookSpecificOutput: cleanOut }));
} catch (e) {
  process.stderr.write(`[feat-flow userprompt error] ${String(e)}\n`);
}
