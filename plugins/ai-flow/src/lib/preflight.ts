import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Locate a flow's preflight script and how to run it.
 *
 * Node preflights (`.cjs`/`.mjs`) are preferred — they need only Node (the one
 * universal dependency) and run cross-platform incl. Windows. A legacy
 * `preflight.sh` is still honored for flows that haven't migrated.
 *
 * Returns a shell command string (run via script-executor's platform shell) or
 * null if the flow has no preflight.
 */
export function findPreflightCommand(flowDir: string): string | null {
  for (const ext of ['cjs', 'mjs']) {
    const p = join(flowDir, `preflight.${ext}`);
    if (existsSync(p)) return `node "${p}"`;
  }
  const sh = join(flowDir, 'preflight.sh');
  if (existsSync(sh)) return `sh "${sh}"`;
  return null;
}
