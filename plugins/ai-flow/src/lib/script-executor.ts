import { spawnSync } from 'child_process';

export interface ScriptResult {
  ok: boolean;
  reason: string;
  /**
   * Output a PASSING script still wants a human to see. Gate scripts write
   * `⚠ …` lines for assertions they had to skip — "the gate looks like it is
   * checking, but for this ticket it is a no-op" is more dangerous than having
   * no gate at all, so those lines must survive a green run. Dropping every
   * byte on `status === 0` (the previous behaviour) made them visible only when
   * the gate failed for some OTHER reason, i.e. exactly when they don't matter.
   */
  notes?: string;
}

export interface RunScriptOptions {
  timeout_ms?: number;
  /**
   * Absolute paths a flow script needs and can no longer derive on its own.
   *
   * Scripts used to sit next to the flow's `state/` in the project and take both
   * from `__dirname` (`join(__dirname, '..')`). They now ship with the plugin, so
   * `__dirname` says nothing about which project is running them — every script
   * would resolve the plugin's own repository. `AI_FLOW_FLOW_DIR` is the project's
   * `.ai-flow/<flow>/` (state and config live there); `AI_FLOW_PROJECT_ROOT` is the
   * flow anchor, which is NOT necessarily the git root (monorepo sub-project
   * installs differ — this plugin's own repo is one).
   */
  env?: Record<string, string>;
}

export async function runScript(
  command: string,
  cwd: string,
  opts?: RunScriptOptions
): Promise<ScriptResult> {
  const timeout = opts?.timeout_ms ?? 30_000;

  // shell:true runs `command` via the platform default shell (sh on POSIX,
  // cmd.exe on Windows) instead of hardcoding `sh` — so a Node-based preflight
  // (`node "..."`) and ordinary validator commands work cross-platform.
  const result = spawnSync(command, {
    cwd,
    ...(opts?.env && { env: { ...process.env, ...opts.env } }),
    timeout,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
    shell: true,
  });

  if (result.signal === 'SIGTERM' || result.error?.message?.includes('ETIMEDOUT') || (result.status === null && result.signal)) {
    return { ok: false, reason: `Script timed out after ${timeout}ms` };
  }

  if (result.error) {
    return { ok: false, reason: result.error.message };
  }

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    return { ok: false, reason: output || `Script exited with code ${result.status ?? 'unknown'}` };
  }

  const notes = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return { ok: true, reason: '', ...(notes && { notes }) };
}
