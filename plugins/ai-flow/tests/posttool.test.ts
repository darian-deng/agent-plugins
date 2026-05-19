import { describe, it, expect, afterEach } from 'vitest';
import { handlePostTool } from '../src/lib/posttool-handler.js';
import { readActiveState } from '../src/lib/state.js';
import { createFlowTestRepo, writeActiveState, MINIMAL_CONFIG } from './fixtures/helpers.js';
import type { PostToolInput } from '../src/lib/types.js';

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

function makeInput(repoRoot: string, toolName: string, contextPct: number): PostToolInput {
  return {
    hook_event_name: 'PostToolUse',
    session_id: 'sess-1',
    cwd: repoRoot,
    tool_name: toolName,
    tool_input: {},
    tool_response: null,
    context_size_pct: contextPct,
  } as PostToolInput & { context_size_pct: number };
}

describe('handlePostTool', () => {
  it('no active flow → null', async () => {
    const repo = makeRepo();
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 80));
    expect(out).toBeNull();
  });

  it('non-write tool → null', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Read', 80));
    expect(out).toBeNull();
  });

  it('write tool + context below warn_at_pct → null', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 50));
    expect(out).toBeNull();
  });

  it('write tool + context ≥ warn_at_pct → warning injected', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 75));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toMatch(/context|75/i);
  });

  it('warning state saved in active.json after triggering', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    await handlePostTool(makeInput(repo.repoRoot, 'Write', 75));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.context_warning.warned).toBe(true);
    expect(state!.context_warning.warned_at_pct).toBe(75);
  });

  it('warning does not re-trigger if below rewarn_delta_pct threshold', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
      context_warning: { warned: true, warned_at_pct: 75, warned_at: new Date().toISOString() },
    });
    // 76% — only 1% above last warning, delta not exceeded
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 76));
    expect(out).toBeNull();
  });
});
