import { describe, it, expect, afterEach } from 'vitest';
import { handlePostTool } from '../src/lib/posttool-handler.js';
import { readActiveState } from '../src/lib/state.js';
import { createFlowTestRepo, writeActiveState, MINIMAL_CONFIG, BLOCKING_CONFIG } from './fixtures/helpers.js';
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
    // Default warn_at_pct is now 50; use 49 to stay below threshold
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 49));
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
    // 76% — only 1% above last warning, rewarn_delta is 5, not exceeded
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 76));
    expect(out).toBeNull();
  });
});

describe('handlePostTool — block_at_pct', () => {
  function makeBlockingRepo() {
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    return repo;
  }

  it('context below block_at_pct → no block message', async () => {
    const repo = makeBlockingRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    // 59% is below block_at_pct=60
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 59));
    // Should warn (above warn_at_pct=30) but not block
    expect(out?.additionalContext).not.toMatch(/blocked/i);
  });

  it('context >= block_at_pct → block message returned', async () => {
    const repo = makeBlockingRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 65));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toMatch(/CONTEXT BLOCKED/i);
    expect(out!.additionalContext).toContain('65%');
  });

  it('context >= block_at_pct → context_blocked saved as true in state', async () => {
    const repo = makeBlockingRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    await handlePostTool(makeInput(repo.repoRoot, 'Write', 65));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.context_blocked).toBe(true);
  });

  it('context_blocked already true → still returns block message (no double-write)', async () => {
    const repo = makeBlockingRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
      context_blocked: true,
      context_warning: { warned: true, warned_at_pct: 65, warned_at: new Date().toISOString() },
    });
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 70));
    expect(out!.additionalContext).toMatch(/CONTEXT BLOCKED/i);
  });

  it('no block_at_pct in config → block never triggers even at 100%', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 100));
    // Should warn but not block
    expect(out).not.toBeNull();
    expect(out!.additionalContext).not.toMatch(/CONTEXT BLOCKED/i);
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.context_blocked).toBe(false);
  });
});
