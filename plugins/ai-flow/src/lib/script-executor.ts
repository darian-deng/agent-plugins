import { spawnSync } from 'child_process';

export interface ScriptResult {
  ok: boolean;
  reason: string;
}

export interface RunScriptOptions {
  timeout_ms?: number;
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

  return { ok: true, reason: '' };
}
