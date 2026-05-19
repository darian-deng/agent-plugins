import { spawnSync } from 'child_process';
export async function runScript(command, cwd, opts) {
    const timeout = opts?.timeout_ms ?? 30_000;
    const result = spawnSync('sh', ['-c', command], {
        cwd,
        timeout,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
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
//# sourceMappingURL=script-executor.js.map