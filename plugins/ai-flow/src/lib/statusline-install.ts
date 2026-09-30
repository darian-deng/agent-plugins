import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { PLUGIN_ROOT } from './flow-paths.js';
import { claudeDir } from './session-registry.js';

/**
 * Puts the agent panel's status script where the plugin's `settings.json` can reach it.
 *
 * `settings.json` → `subagentStatusLine.command` is run by the host with only
 * `CLAUDE_PROJECT_DIR` added to the environment: `${CLAUDE_PLUGIN_ROOT}` expands to an
 * empty string there, and the failure is silent (a debug-log line, default rows). The
 * install path also cannot be spelled in advance — it moves with the marketplace name and
 * the version. So SessionStart copies the script to a fixed location under the Claude
 * config dir.
 *
 * Runs on every SessionStart, flow or not — a session that later starts a flow needs the
 * script already in place — and on every UserPromptSubmit, because `/reload-plugins`
 * fires no SessionStart. Writes only when the content differs, via tmp + rename so a
 * panel refresh never runs half a file. Best-effort: a failure costs the panel rows, never
 * the session.
 */
export const STATUSLINE_SCRIPT = 'subagent-statusline.cjs';

export function statuslineInstallDir(): string {
  return join(claudeDir(), 'ai-flow');
}

function writeIfChanged(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, 'utf-8') === content) return;
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function installSubagentStatusline(pluginRoot: string = PLUGIN_ROOT): void {
  try {
    const src = join(pluginRoot, 'statusline', STATUSLINE_SCRIPT);
    if (!existsSync(src)) return;
    const dir = statuslineInstallDir();
    mkdirSync(dir, { recursive: true });
    writeIfChanged(join(dir, STATUSLINE_SCRIPT), readFileSync(src, 'utf-8'));
  } catch { /* best-effort: the panel keeps its default rows */ }
}
