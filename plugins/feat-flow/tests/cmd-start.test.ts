import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import { execSync } from 'child_process';
import { handleStart } from '../src/lib/commands/start.js';
import { readActiveState } from '../src/lib/state.js';
import { createFlowTestRepo, MINIMAL_CONFIG } from './fixtures/helpers.js';
import { writeFileSync, mkdirSync } from 'fs';

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeRepo(opts?: { preflightScript?: string }) {
  const repo = createFlowTestRepo('test-flow', MINIMAL_CONFIG, opts);
  cleanups.push(repo.cleanup);
  return repo;
}

describe('handleStart', () => {
  it("no config.json for flow → error 'use /ai-flow'", async () => {
    const repo = makeRepo();
    const result = await handleStart(repo.repoRoot, 'no-such-flow', 'do something', 'sess-1', 0);
    expect(result.action).toBe('deny');
    expect(result.reason).toMatch(/ai-flow/i);
  });

  it('empty requirement string → error', async () => {
    const repo = makeRepo();
    const result = await handleStart(repo.repoRoot, 'test-flow', '  ', 'sess-1', 0);
    expect(result.action).toBe('deny');
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/requirement/i);
  });

  it('any flow already active → error mentioning abort', async () => {
    const repo = makeRepo();
    // start once successfully
    await handleStart(repo.repoRoot, 'test-flow', 'first task', 'sess-1', 0);
    // try to start again
    const result = await handleStart(repo.repoRoot, 'test-flow', 'second task', 'sess-1', 0);
    expect(result.action).toBe('deny');
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/abort/i);
  });

  it('dirty git working tree → error mentioning git stash', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo.repoRoot, 'dirty.txt'), 'untracked change');
    const result = await handleStart(repo.repoRoot, 'test-flow', 'do task', 'sess-1', 0);
    expect(result.action).toBe('deny');
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/git stash|clean/i);
  });

  it('preflight.sh exits 1 → error with preflight output', async () => {
    const repo = createFlowTestRepo('test-flow', MINIMAL_CONFIG, {
      preflightScript: '#!/bin/sh\necho "missing dependency: foo"\nexit 1\n',
    });
    cleanups.push(repo.cleanup);
    const result = await handleStart(repo.repoRoot, 'test-flow', 'do task', 'sess-1', 0);
    expect(result.action).toBe('deny');
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/missing dependency|preflight/i);
  });

  it('preflight.sh does not exist → skipped (not an error)', async () => {
    const repo = createFlowTestRepo('test-flow', MINIMAL_CONFIG, { noPreflight: true });
    cleanups.push(repo.cleanup);
    const result = await handleStart(repo.repoRoot, 'test-flow', 'do task', 'sess-1', 0);
    expect(result.action).toBe('allow');
  });

  it('context_size above block_start_if_above_pct → error mentioning /clear', async () => {
    const repo = makeRepo();
    const result = await handleStart(repo.repoRoot, 'test-flow', 'do task', 'sess-1', 96);
    expect(result.action).toBe('deny');
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/\/clear|context/i);
  });

  it('all checks pass → creates active.json with first stage', async () => {
    const repo = makeRepo();
    const result = await handleStart(repo.repoRoot, 'test-flow', 'build feature X', 'sess-1', 0);
    expect(result.action).toBe('allow');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).not.toBeNull();
    expect(state!.current_stage).toBe('work');
    expect(state!.requirement).toBe('build feature X');
    expect(state!.flow_name).toBe('test-flow');
  });

  it('active.json base_sha matches current git HEAD', async () => {
    const repo = makeRepo();
    await handleStart(repo.repoRoot, 'test-flow', 'build feature X', 'sess-1', 0);
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    const head = execSync('git rev-parse HEAD', { cwd: repo.repoRoot }).toString().trim();
    expect(state!.base_sha).toBe(head);
  });

  it('flow_id format matches expected regex', async () => {
    const repo = makeRepo();
    await handleStart(repo.repoRoot, 'test-flow', 'do task', 'sess-1', 0);
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.flow_id).toMatch(/^test-flow-[a-z0-9]+$/);
  });

  it('additionalContext includes first stage prompt content', async () => {
    const repo = makeRepo();
    const result = await handleStart(repo.repoRoot, 'test-flow', 'do task', 'sess-1', 0);
    expect(result.action).toBe('allow');
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toContain('Stage: work');
  });
});
