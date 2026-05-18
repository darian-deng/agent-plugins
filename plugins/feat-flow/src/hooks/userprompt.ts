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

  // UserPromptSubmit blocking requires exit 2 + stderr, NOT permissionDecision in JSON.
  // JSON output is only used for additionalContext injection.
  if (out?.permissionDecision === 'deny') {
    process.stderr.write((out.permissionDecisionReason ?? 'Blocked by feat-flow') + '\n');
    process.exit(2);
  }

  // Strip permissionDecision from output — only additionalContext is valid for UserPromptSubmit
  const { permissionDecision: _, permissionDecisionReason: __, ...cleanOut } = out ?? {};
  const cleanResult = { ...result, hookSpecificOutput: cleanOut };
  process.stdout.write(JSON.stringify(cleanResult));
} catch (e) {
  process.stderr.write(`[feat-flow userprompt error] ${String(e)}\n`);
}
