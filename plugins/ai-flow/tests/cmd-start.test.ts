import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import { execSync } from 'child_process';
import { handleStart } from '../src/lib/commands/start.js';
import { readActiveState } from '../src/lib/state.js';
import { createFlowTestRepo, MINIMAL_CONFIG } from './fixtures/helpers.js';
import { writeFileSync, mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { writeActiveState } from './fixtures/helpers.js';

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
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/ai-flow/i);
  });

  it('empty requirement string → error', async () => {
    const repo = makeRepo();
    const result = await handleStart(repo.repoRoot, 'test-flow', '  ', 'sess-1', 0);
    expect(result.action).toBe('deny');
    const reason = (result as { action: 'deny'; reason: string }).reason;
    expect(reason).toMatch(/requirement/i);
    // The actual flow name must appear, not the literal placeholder '{flowName}'
    expect(reason).toContain('test-flow');
    expect(reason).not.toContain('{flowName}');
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

  it('seeds history_session_ids with the creating session', async () => {
    const repo = makeRepo();
    await handleStart(repo.repoRoot, 'test-flow', 'build feature X', 'sess-1', 0);
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    // The creating session owns last_session_id immediately, so SessionStart
    // never appends it; start must seed history itself or it's lost forever.
    expect(state!.history_session_ids).toEqual(['sess-1']);
  });

  it('active.json base_sha matches current git HEAD', async () => {
    const repo = makeRepo();
    await handleStart(repo.repoRoot, 'test-flow', 'build feature X', 'sess-1', 0);
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    const head = execSync('git rev-parse HEAD', { cwd: repo.repoRoot }).toString().trim();
    expect(state!.base_sha).toBe(head);
  });

  it('flow_id format matches expected regex (<date>-<rand4>)', async () => {
    const repo = makeRepo();
    await handleStart(repo.repoRoot, 'test-flow', 'do task', 'sess-1', 0);
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    // Engine generates flow_id as <YYYY-MM-DD>-<rand4>, e.g., "2026-05-21-x7k3"
    expect(state!.flow_id).toMatch(/^\d{4}-\d{2}-\d{2}-[a-z0-9]{4}$/);
  });

  it('additionalContext includes first stage prompt content', async () => {
    const repo = makeRepo();
    const result = await handleStart(repo.repoRoot, 'test-flow', 'do task', 'sess-1', 0);
    expect(result.action).toBe('allow');
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toContain('Stage: work');
  });
});

// `hasActiveFlow` 会解析到本仓库**另一个检出**里的 flow（`ResolvedFlow.viaSibling`）。原先那条
// 通用拒绝在这种情况下建议 `<flow> abort`——在当前检出执行会销毁另一条开发线的流程状态。
describe('handleStart — 跨检出', () => {
  it('解析到的 flow 在另一个检出 → 拒绝，且⛔不再建议 abort', async () => {
    const repo = makeRepo();
    const parent = mkdtempSync(join(tmpdir(), 'ai-flow-xco-start-'));
    const a = join(parent, 'line-a');
    const b = join(parent, 'line-b');
    execSync(`git worktree add -q "${a}" -b feat/line-a`, { cwd: repo.repoRoot });
    execSync(`git worktree add -q "${b}" -b feat/line-b`, { cwd: repo.repoRoot });
    writeActiveState(a, 'test-flow', {
      flow_id: 'flow-in-a', flow_name: 'test-flow', requirement: 'A 的需求',
      current_stage: 'work', base_sha: 'aaa111',
    });
    cleanups.push(() => execSync(`rm -rf "${parent}"`));

    const result = await handleStart(b, 'test-flow', '在 B 上做另一件事', 'sess-in-b', 0, b);
    expect(result.action).toBe('deny');
    const reason = (result as { action: 'deny'; reason: string }).reason;
    expect(reason).toContain(a);                        // 点名那个检出
    expect(reason).toContain('mv ');                    // 给可执行出路
    expect(reason).not.toMatch(/Run 'test-flow abort'/); // ⛔ 这条建议会销毁 A 的状态
    expect(await readActiveState(b, 'test-flow')).toBeNull();
  });
});
