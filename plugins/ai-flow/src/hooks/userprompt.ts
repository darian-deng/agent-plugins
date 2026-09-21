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

  // Covers both shapes, and deliberately NOT via an early `process.exit(0)`: a write
  // to a pipe is asynchronous, so exiting on the next line can truncate it. Falling
  // off the end of the script lets Node flush first.
  //
  // A watchdog tick the engine decided not to forward carries a top-level
  // `decision: "block"`, which drops the prompt before the model sees it and prints
  // `reason` to the developer. The exit-2 path above would do the same, but as a hook
  // ERROR, which a suppressed tick is not.
  process.stdout.write(JSON.stringify(result));
} catch (e) {
  process.stderr.write(`ai-flow internal error: ${String(e)}\n`);
}
