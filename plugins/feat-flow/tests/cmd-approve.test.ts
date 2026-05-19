import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { handleApprove } from '../src/lib/commands/approve.js';
import { readActiveState, writeActiveState, writeGateToken, isGateActive } from '../src/lib/state.js';
import { createFlowTestRepo, writeActiveState as fixtureWriteState, writeGateToken as fixtureWriteToken, MINIMAL_CONFIG } from './fixtures/helpers.js';

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

describe('handleApprove', () => {
  it("no active flow → error 'no active flow'", async () => {
    const repo = makeRepo();
    const result = await handleApprove(repo.repoRoot, 'test-flow', 'some-token');
    expect(result.action).toBe('deny');
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/no active flow/i);
  });

  it("no gate active (no gate-token) → error 'no pending gate'", async () => {
    const repo = makeRepo();
    fixtureWriteState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const result = await handleApprove(repo.repoRoot, 'test-flow', 'some-token');
    expect(result.action).toBe('deny');
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/no pending gate/i);
  });

  it('wrong token → error with token hint', async () => {
    const repo = makeRepo();
    fixtureWriteState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    fixtureWriteToken(repo.repoRoot, 'test-flow', 'correct-token');
    const result = await handleApprove(repo.repoRoot, 'test-flow', 'wrong-token');
    expect(result.action).toBe('deny');
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/invalid token|wrong/i);
  });

  it('correct token + not last stage → advances current_stage, deletes gate-token, injects next stage', async () => {
    const repo = makeRepo();
    fixtureWriteState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build something',
      current_stage: 'work',
      base_sha: 'abc',
    });
    fixtureWriteToken(repo.repoRoot, 'test-flow', 'tok-secret');
    const result = await handleApprove(repo.repoRoot, 'test-flow', 'tok-secret');
    expect(result.action).toBe('allow');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('review');
    expect(await isGateActive(repo.repoRoot, 'test-flow')).toBe(false);
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toContain('Stage: review');
  });

  it('correct token + last stage → flow complete, clears state, success message', async () => {
    const repo = makeRepo();
    fixtureWriteState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build something',
      current_stage: 'review',
      base_sha: 'abc',
    });
    fixtureWriteToken(repo.repoRoot, 'test-flow', 'tok-final');
    const result = await handleApprove(repo.repoRoot, 'test-flow', 'tok-final');
    expect(result.action).toBe('allow');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).toBeNull();
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toMatch(/complete|done|finished/i);
  });

  it('after approve, active.json shows new current_stage', async () => {
    const repo = makeRepo();
    fixtureWriteState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    fixtureWriteToken(repo.repoRoot, 'test-flow', 'tok-abc');
    await handleApprove(repo.repoRoot, 'test-flow', 'tok-abc');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('review');
  });
});
