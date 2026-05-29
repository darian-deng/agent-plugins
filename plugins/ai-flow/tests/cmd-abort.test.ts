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
    const result = await handleAbort(repo.repoRoot, 'test-flow');
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
    const result = await handleAbort(repo.repoRoot, 'test-flow');
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
    const result = await handleAbort(repo.repoRoot, 'test-flow', '--confirm');
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
    await handleAbort(repo.repoRoot, 'test-flow', '--confirm');
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
    await handleAbort(repo.repoRoot, 'test-flow', '--confirm');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).toBeNull();
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
    await handleAbort(repo.repoRoot, 'test-flow', '--confirm');
    const branches = execSync('git branch', { cwd: repo.repoRoot, encoding: 'utf-8' });
    expect(branches).toMatch(/test-flow\/aborted-\d{4}-\d{2}-\d{2}/);
  });
});
