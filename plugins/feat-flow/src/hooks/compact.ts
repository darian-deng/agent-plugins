#!/usr/bin/env node
import { readFileSync } from 'fs';
import { handlePreCompact } from '../lib/compact-handler.js';
import type { PreCompactInput } from '../lib/types.js';

const raw = (() => { try { return readFileSync(0, 'utf-8'); } catch { return '{}'; } })();
const input = (() => { try { return JSON.parse(raw) as PreCompactInput; } catch { return {} as PreCompactInput; } })();

try {
  const result = await handlePreCompact(input);
  if (result) process.stdout.write(JSON.stringify(result));
} catch (e) {
  process.stderr.write(`[feat-flow compact error] ${String(e)}\n`);
}
