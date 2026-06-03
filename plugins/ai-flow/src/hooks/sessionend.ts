#!/usr/bin/env node
import { readFileSync } from 'fs';
import { handleSessionEnd } from '../lib/session-end-handler.js';
import type { SessionEndInput } from '../lib/types.js';

const raw = (() => { try { return readFileSync(0, 'utf-8'); } catch { return '{}'; } })();
const input = (() => { try { return JSON.parse(raw) as SessionEndInput; } catch { return {} as SessionEndInput; } })();

try {
  await handleSessionEnd(input);
} catch (e) {
  process.stderr.write(`[ai-flow sessionend error] ${String(e)}\n`);
}
