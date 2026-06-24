import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { handleResume } from '../src/lib/commands/resume.js';
import { readActiveState } from '../src/lib/state.js';
import { createFlowTestRepo, writeActiveState, MINIMAL_CONFIG } from './fixtures/helpers.js';

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

function createAbortBranch(
  repoRoot: string,
  flowName: string,
  branchName: string,
  snapshot: Record<string, unknown>
): void {
  const flowId = (snapshot['flow_id'] as string) ?? 'test-flow-abc';
  execSync(`git checkout -b "${branchName}"`, { cwd: repoRoot });
  const snapshotDir = join(repoRoot, 'docs', flowName, flowId);
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(join(snapshotDir, 'state-snapshot.json'), JSON.stringify(snapshot));
  execSync('git add -A', { cwd: repoRoot });
  execSync(`git commit -m "abort snapshot"`, { cwd: repoRoot });
  execSync('git checkout -', { cwd: repoRoot });
}

describe('handleResume', () => {
  it('no branch name → error with usage hint', async () => {
    const repo = makeRepo();
    const result = await handleResume(repo.repoRoot, 'test-flow', 'test-sess', '');
    expect(result.action).toBe('deny');
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/usage|branch/i);
  });

  it('branch does not exist → error', async () => {
    const repo = makeRepo();
    const result = await handleResume(repo.repoRoot, 'test-flow', 'test-sess', 'test-flow/aborted-nonexistent');
    expect(result.action).toBe('deny');
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/not found|does not exist/i);
  });

  it('branch exists but no snapshot → error', async () => {
    const repo = makeRepo();
    execSync('git checkout -b test-flow/aborted-no-snapshot', { cwd: repo.repoRoot });
    execSync('git checkout -', { cwd: repo.repoRoot });
    const result = await handleResume(repo.repoRoot, 'test-flow', 'test-sess', 'test-flow/aborted-no-snapshot');
    expect(result.action).toBe('deny');
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/snapshot|not found/i);
  });

  it('snapshot exists → restores active.json with correct current_stage', async () => {
    const repo = makeRepo();
    const snapshot = {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'resumed task',
      current_stage: 'work',
      base_sha: 'abc123',
      started_at: '2024-01-01T00:00:00.000Z',
      last_session_id: 'old-session',
      context_size: 50,
      context_warning: { warned: false, warned_at_pct: null, warned_at: null },
    };
    createAbortBranch(repo.repoRoot, 'test-flow', 'test-flow/aborted-2024-01-01T00-00-00', snapshot);
    const result = await handleResume(repo.repoRoot, 'test-flow', 'test-sess', 'test-flow/aborted-2024-01-01T00-00-00');
    expect(result.action).toBe('allow');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('work');
    expect(state!.requirement).toBe('resumed task');
  });

  it('last_session_id reset to null on restore (new session)', async () => {
    const repo = makeRepo();
    const snapshot = {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'resume test',
      current_stage: 'work',
      base_sha: 'abc',
      started_at: '2024-01-01T00:00:00.000Z',
      last_session_id: 'old-session-999',
      context_size: 0,
      context_warning: { warned: false, warned_at_pct: null, warned_at: null },
    };
    createAbortBranch(repo.repoRoot, 'test-flow', 'test-flow/aborted-resume-test', snapshot);
    await handleResume(repo.repoRoot, 'test-flow', 'test-sess', 'test-flow/aborted-resume-test');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.last_session_id).toBeNull();
  });

  it('cannot resume if another flow already active', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-active',
      flow_name: 'test-flow',
      requirement: 'active task',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const result = await handleResume(repo.repoRoot, 'test-flow', 'test-sess', 'test-flow/aborted-something');
    expect(result.action).toBe('deny');
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/already active|abort/i);
  });

  it('injects stage context from current stage prompt file', async () => {
    const repo = makeRepo();
    const snapshot = {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'with context',
      current_stage: 'work',
      base_sha: 'abc',
      started_at: '2024-01-01T00:00:00.000Z',
      last_session_id: null,
      context_size: 0,
      context_warning: { warned: false, warned_at_pct: null, warned_at: null },
    };
    createAbortBranch(repo.repoRoot, 'test-flow', 'test-flow/aborted-ctx-test', snapshot);
    const result = await handleResume(repo.repoRoot, 'test-flow', 'test-sess', 'test-flow/aborted-ctx-test');
    expect(result.action).toBe('allow');
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toContain('Stage: work');
  });

  it('resuming into a GATED stage injects the gate protocol note', async () => {
    const repo = makeRepo();
    const snapshot = {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'resume gated',
      current_stage: 'review', // review has gate: true in MINIMAL_CONFIG
      base_sha: 'abc',
      started_at: '2024-01-01T00:00:00.000Z',
      last_session_id: null,
      context_size: 0,
      context_warning: { warned: false, warned_at_pct: null, warned_at: null },
    };
    createAbortBranch(repo.repoRoot, 'test-flow', 'test-flow/aborted-gated', snapshot);
    const result = await handleResume(repo.repoRoot, 'test-flow', 'test-sess', 'test-flow/aborted-gated');
    expect(result.action).toBe('allow');
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toContain('Gate 协议');
  });

  it('seeds history_session_ids with the resuming session', async () => {
    const repo = makeRepo();
    const snapshot = {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'resume hist',
      current_stage: 'work',
      base_sha: 'abc',
      started_at: '2024-01-01T00:00:00.000Z',
      last_session_id: null,
      context_size: 0,
      context_warning: { warned: false, warned_at_pct: null, warned_at: null },
    };
    createAbortBranch(repo.repoRoot, 'test-flow', 'test-flow/aborted-hist', snapshot);
    await handleResume(repo.repoRoot, 'test-flow', 'sess-resume', 'test-flow/aborted-hist');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.history_session_ids).toEqual(['sess-resume']);
  });
});
