#!/usr/bin/env node
import { readFileSync } from 'fs';
import { handleUserPromptSubmit } from '../lib/commands/router.js';
import type { UserPromptInput } from '../lib/types.js';

const raw = (() => { try { return readFileSync(0, 'utf-8'); } catch { return '{}'; } })();
const input = (() => { try { return JSON.parse(raw) as UserPromptInput; } catch { return {} as UserPromptInput; } })();

try {
  const result = await handleUserPromptSubmit(input);
  if (result) process.stdout.write(JSON.stringify(result));
} catch (e) {
  process.stderr.write(`[feat-flow userprompt error] ${String(e)}\n`);
}
