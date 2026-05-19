import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { runScript } from '../src/lib/script-executor.js';
import { hasPython3 } from './fixtures/helpers.js';

let tmpDirs: string[] = [];

function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ai-flow-script-test-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs) execSync(`rm -rf "${d}"`);
  tmpDirs = [];
});

describe('runScript — bash/sh', () => {
  it("'exit 0' → { ok: true }", async () => {
    const root = makeTmp();
    const result = await runScript('exit 0', root);
    expect(result.ok).toBe(true);
  });

  it("'exit 1' → { ok: false }", async () => {
    const root = makeTmp();
    const result = await runScript('exit 1', root);
    expect(result.ok).toBe(false);
  });

  it("'echo check failed && exit 2' → { ok: false, reason: 'check failed' }", async () => {
    const root = makeTmp();
    const result = await runScript('echo "check failed" && exit 2', root);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('check failed');
  });

  it('real script file → passes', async () => {
    const root = makeTmp();
    const scriptsDir = join(root, 'scripts');
    mkdirSync(scriptsDir);
    const scriptPath = join(scriptsDir, 'check.sh');
    writeFileSync(scriptPath, '#!/bin/sh\necho "all good"\nexit 0\n');
    chmodSync(scriptPath, 0o755);
    const result = await runScript('bash scripts/check.sh', root);
    expect(result.ok).toBe(true);
  });

  it("nonexistent cmd → { ok: false, reason: includes error info }", async () => {
    const root = makeTmp();
    const result = await runScript('nonexistent-cmd-xyz-abc', root);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('timeout: slow script → { ok: false, reason: includes timed out }', async () => {
    const root = makeTmp();
    const result = await runScript('sleep 100', root, { timeout_ms: 100 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/timed out/i);
  });
});

describe('runScript — node', () => {
  it("node exit(0) → { ok: true }", async () => {
    const root = makeTmp();
    const result = await runScript('node -e "process.exit(0)"', root);
    expect(result.ok).toBe(true);
  });

  it("node exit(1) → { ok: false }", async () => {
    const root = makeTmp();
    const result = await runScript('node -e "process.exit(1)"', root);
    expect(result.ok).toBe(false);
  });

  it('real node script file → passes', async () => {
    const root = makeTmp();
    const scriptsDir = join(root, 'scripts');
    mkdirSync(scriptsDir);
    writeFileSync(join(scriptsDir, 'validate.js'), 'process.exit(0);\n');
    const result = await runScript('node scripts/validate.js', root);
    expect(result.ok).toBe(true);
  });

  it('timeout with slow node script', async () => {
    const root = makeTmp();
    const result = await runScript('node -e "setTimeout(()=>{},10000)"', root, { timeout_ms: 100 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/timed out/i);
  });
});

describe('runScript — python3', () => {
  it.skipIf(!hasPython3())("python3 exit(0) → { ok: true }", async () => {
    const root = makeTmp();
    const result = await runScript('python3 -c "exit(0)"', root);
    expect(result.ok).toBe(true);
  });

  it.skipIf(!hasPython3())("python3 exit(1) → { ok: false }", async () => {
    const root = makeTmp();
    const result = await runScript('python3 -c "exit(1)"', root);
    expect(result.ok).toBe(false);
  });

  it.skipIf(!hasPython3())('timeout with slow python script', async () => {
    const root = makeTmp();
    const result = await runScript('python3 -c "import time; time.sleep(100)"', root, { timeout_ms: 100 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/timed out/i);
  });
});

describe('runScript — cwd', () => {
  it('script runs with cwd=repoRoot so relative paths resolve', async () => {
    const root = makeTmp();
    writeFileSync(join(root, 'marker.txt'), 'present');
    const result = await runScript('test -f marker.txt', root);
    expect(result.ok).toBe(true);
  });

  it('script can read files from the repo root', async () => {
    const root = makeTmp();
    writeFileSync(join(root, 'data.txt'), 'hello');
    const result = await runScript('cat data.txt', root);
    expect(result.ok).toBe(true);
  });
});
