#!/usr/bin/env node
import { readFileSync } from 'fs';
import { handleUserPrompt } from '../lib/userprompt-handler.js';
import type { UserPromptInput, UserPromptOutput } from '../lib/types.js';

const raw = (() => { try { return readFileSync(0, 'utf-8'); } catch { return '{}'; } })();
const input = (() => { try { return JSON.parse(raw) as UserPromptInput; } catch { return {} as UserPromptInput; } })();

try {
  const result = await handleUserPrompt(input);
  if (!result) process.exit(0);

  const out = result.hookSpecificOutput as UserPromptOutput | undefined;

  if (out?.permissionDecision === 'deny') {
    process.stderr.write((out.permissionDecisionReason ?? 'Blocked by ai-flow') + '\n');
    process.exit(2);
  }

  process.stdout.write(JSON.stringify(result));
} catch (e) {
  process.stderr.write(`ai-flow internal error: ${String(e)}\n`);
}
