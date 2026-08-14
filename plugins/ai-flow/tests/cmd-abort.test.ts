import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { handleAbort } from '../src/lib/commands/abort.js';
import { readActiveState } from '../src/lib/state.js';
import { createFlowTestRepo, writeActiveState, writeSignal, MINIMAL_CONFIG } from './fixtures/helpers.js';

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeRepo() {
  const repo = createFlowTestRepo('test-flow', MINIMAL_CONFIG);
  cleanups.push(repo.cleanup);
  return repo;
}

describe('handleAbort', () => {
  it("no active flow → error 'no active flow'", async () => {
    const repo = makeRepo();
    const result = await handleAbort(repo.repoRoot, 'test-flow', 'test-sess');
    expect(result.action).toBe('deny');
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/no active flow/i);
  });

  it('abort without --confirm → deny with confirmation prompt (no state change)', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test abort',
      current_stage: 'work',
      base_sha: execSync('git rev-parse HEAD', { cwd: repo.repoRoot, encoding: 'utf-8' }).trim(),
    });
    const result = await handleAbort(repo.repoRoot, 'test-flow', 'test-sess');
    expect(result.action).toBe('deny');
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/--confirm/);
    // state must NOT be deleted — abort without confirm is a no-op
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).not.toBeNull();
  });

  it('active flow + --confirm → creates branch {flowName}/aborted-{timestamp}', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test abort',
      current_stage: 'work',
      base_sha: execSync('git rev-parse HEAD', { cwd: repo.repoRoot, encoding: 'utf-8' }).trim(),
    });
    const result = await handleAbort(repo.repoRoot, 'test-flow', 'test-sess', '--confirm');
    expect(result.action).toBe('allow');
    const branches = execSync('git branch', { cwd: repo.repoRoot, encoding: 'utf-8' });
    expect(branches).toMatch(/test-flow\/aborted-/);
  });

  it('after abort --confirm, active.json is deleted', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test abort',
      current_stage: 'work',
      base_sha: execSync('git rev-parse HEAD', { cwd: repo.repoRoot, encoding: 'utf-8' }).trim(),
    });
    await handleAbort(repo.repoRoot, 'test-flow', 'test-sess', '--confirm');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).toBeNull();
  });

  it('after abort --confirm, gate state is fully cleared (active.json deleted)', async () => {
    const repo = makeRepo();
    const baseSha = execSync('git rev-parse HEAD', { cwd: repo.repoRoot, encoding: 'utf-8' }).trim();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: baseSha,
    });
    writeSignal(repo.repoRoot, 'test-flow', 'review');
    await handleAbort(repo.repoRoot, 'test-flow', 'test-sess', '--confirm');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).toBeNull();
  });

  // abort 的快照只在 repoRoot 跑 `git add -A`，所以它必须先发现本 flow 的 worktree 并拒绝，
  // 否则那些树里的改动会被静默丢掉而 abort 承诺的是相反的事。落点自 0.50.0 起在仓库**同级**
  // （嵌在仓库内会让 worktree 里的 TS 收进主树的 `node_modules/@types`），只认旧落点就漏了。
  it('仓库同级落点下有本 flow 的 worktree → 拒绝 abort（不静默丢改动）', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test abort',
      current_stage: 'work',
      base_sha: execSync('git rev-parse HEAD', { cwd: repo.repoRoot, encoding: 'utf-8' }).trim(),
    });
    const lanes = repo.repoRoot + '.ai-flow-worktrees';
    execSync(`git worktree add -q "${join(lanes, 'test-flow-abc-R1')}" -b wt/test-flow-abc-R1`, { cwd: repo.repoRoot });
    cleanups.push(() => execSync(`rm -rf "${lanes}"`));

    const result = await handleAbort(repo.repoRoot, 'test-flow', 'test-sess', '--confirm');
    expect(result.action).toBe('deny');
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/worktree/i);
    // 拒绝必须是真的没动状态，否则「拒绝」只是话术。
    expect(await readActiveState(repo.repoRoot, 'test-flow')).not.toBeNull();
  });

  it('abort --confirm branch name includes ISO timestamp (regex)', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: execSync('git rev-parse HEAD', { cwd: repo.repoRoot, encoding: 'utf-8' }).trim(),
    });
    await handleAbort(repo.repoRoot, 'test-flow', 'test-sess', '--confirm');
    const branches = execSync('git branch', { cwd: repo.repoRoot, encoding: 'utf-8' });
    expect(branches).toMatch(/test-flow\/aborted-\d{4}-\d{2}-\d{2}/);
  });
});
