import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { handleStatus } from '../src/lib/commands/status.js';
import { createFlowTestRepo, writeActiveState, writeGateToken, MINIMAL_CONFIG } from './fixtures/helpers.js';

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

describe('handleStatus', () => {
  it("no active flow → message 'no active flow'", async () => {
    const repo = makeRepo();
    const result = await handleStatus(repo.repoRoot, 'test-flow');
    expect(result.action).toBe('allow');
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toMatch(/no active flow/i);
  });

  it('active flow, no gate → shows flow_name, current_stage, requirement', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build the feature',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const result = await handleStatus(repo.repoRoot, 'test-flow');
    expect(result.action).toBe('allow');
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toContain('test-flow');
    expect(ctx).toContain('work');
    expect(ctx).toContain('build the feature');
  });

  it('active flow, gate active → shows gate hint and approve instruction', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
    });
    writeGateToken(repo.repoRoot, 'test-flow', 'tok-12345');
    const result = await handleStatus(repo.repoRoot, 'test-flow');
    expect(result.action).toBe('allow');
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toMatch(/gate|approve/i);
    expect(ctx).toContain('tok-12345');
  });

  it('context warning state shown if warned: true', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      context_warning: { warned: true, warned_at_pct: 75, warned_at: '2024-01-01T00:00:00Z' },
    });
    const result = await handleStatus(repo.repoRoot, 'test-flow');
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toMatch(/context|75/);
  });
});
