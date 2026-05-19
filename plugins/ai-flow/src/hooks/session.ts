#!/usr/bin/env node
import { readFileSync } from 'fs';
import { handleSessionStart } from '../lib/session-handler.js';
import type { SessionStartInput } from '../lib/types.js';

const raw = (() => { try { return readFileSync(0, 'utf-8'); } catch { return '{}'; } })();
const input = (() => { try { return JSON.parse(raw) as SessionStartInput; } catch { return {} as SessionStartInput; } })();

try {
  const result = await handleSessionStart(input);
  if (result) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: result.additionalContext }
    }));
  }
} catch (e) {
  process.stderr.write(`[ai-flow session error] ${String(e)}\n`);
}
