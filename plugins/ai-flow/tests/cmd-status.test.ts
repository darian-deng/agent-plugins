import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { handleStatus } from '../src/lib/commands/status.js';
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

  it('active flow, gate active → shows approve instruction', async () => {
    const repo = createFlowTestRepo('test-flow', {
      schema_version: '1.0',
      name: 'test-flow',
      stages: [
        { id: 'work', prompt: 'stages/work.md', write_scope: 'unrestricted', completion: { gate: true } },
        { id: 'review', prompt: 'stages/review.md', write_scope: 'unrestricted', completion: {} },
      ],
    });
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
    });
    // signal == nextStage('review') + gate: true → gate pending
    writeSignal(repo.repoRoot, 'test-flow', 'review');
    const result = await handleStatus(repo.repoRoot, 'test-flow');
    expect(result.action).toBe('allow');
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toMatch(/gate|approve/i);
  });

  // The old assertion here was `/context|75/` — no `i` flag against an output that
  // says "Context", so only the "75" alternative ever matched and any wording would
  // have passed. What the echo has to convey is the level AND what is refused at it.
  it('context wrap-up state shown once the threshold has been crossed', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'review',
      base_sha: 'abc',
      context_wrap_up: { at_pct: 75 },
    });
    const result = await handleStatus(repo.repoRoot, 'test-flow');
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    // MINIMAL_CONFIG's `review` stage declares docs_paths, so the refusal is live and
    // the echo names both halves — including the resolved path, {flow_id} expanded.
    expect(ctx).toContain('Context wrap-up started at 75% used');
    expect(ctx).toContain('writes to the codebase are refused');
    expect(ctx).toContain('docs/test-flow/test-flow-abc/');
  });

  // Same latch, on a stage that declares no docs_paths: there is no path the refusal
  // could leave open, so pretool refuses nothing and the echo must not claim it does.
  it('wrap-up on a stage with no docs_paths → echo says nothing is being refused', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      context_wrap_up: { at_pct: 75 },
    });
    const result = await handleStatus(repo.repoRoot, 'test-flow');
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toContain('Context wrap-up started at 75% used');
    expect(ctx).toContain('no docs_paths');
    expect(ctx).toContain('no write is being refused');
    expect(ctx).not.toContain('writes to the codebase are refused');
  });
});
