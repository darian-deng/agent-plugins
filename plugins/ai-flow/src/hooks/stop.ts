#!/usr/bin/env node
import { readFileSync } from 'fs';
import { handleStop } from '../lib/stop-handler.js';
import type { StopInput } from '../lib/types.js';

const raw = (() => { try { return readFileSync(0, 'utf-8'); } catch { return '{}'; } })();
const input = (() => { try { return JSON.parse(raw) as StopInput; } catch { return {} as StopInput; } })();

try {
  const result = await handleStop(input);
  if (result) {
    // `additionalContext` rather than `decision: "block"`: both continue the
    // conversation through the same loop protections, but this one is labelled
    // "Stop hook feedback" instead of surfacing as a hook error the developer has
    // to interpret.
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: result.additionalContext },
    }));
  }
} catch (e) {
  process.stderr.write(`[ai-flow stop error] ${String(e)}\n`);
}
