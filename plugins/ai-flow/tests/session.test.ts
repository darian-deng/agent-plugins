import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { handleSessionStart } from '../src/lib/session-handler.js';
import { readActiveState } from '../src/lib/state.js';
import { createFlowTestRepo, writeActiveState, writeGateToken, MINIMAL_CONFIG } from './fixtures/helpers.js';
import type { SessionStartInput } from '../src/lib/types.js';

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

function makeInput(repoRoot: string, sessionId: string, opts?: Partial<SessionStartInput>): SessionStartInput {
  return {
    hook_event_name: 'SessionStart',
    session_id: sessionId,
    cwd: repoRoot,
    ...opts,
  };
}

describe('handleSessionStart', () => {
  it('no active flow → null (no injection)', async () => {
    const repo = makeRepo();
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-1'));
    expect(out).toBeNull();
  });

  it('active flow, no gate → injects flow summary and stage prompt content', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build feature',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-new'));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toContain('test-flow');
    expect(out!.additionalContext).toContain('work');
    expect(out!.additionalContext).toContain('Stage: work');
  });

  it('active flow with gate → injects gate status', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
    });
    writeGateToken(repo.repoRoot, 'test-flow', 'tok-abc');
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-new'));
    expect(out!.additionalContext).toMatch(/gate|approve/i);
  });

  it('new session → context_warning reset in state', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'old-session',
      context_warning: { warned: true, warned_at_pct: 80, warned_at: '2024-01-01T00:00:00Z' },
    });
    await handleSessionStart(makeInput(repo.repoRoot, 'new-session'));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.context_warning.warned).toBe(false);
  });

  it('same session → context_warning NOT reset', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'same-session',
      context_warning: { warned: true, warned_at_pct: 80, warned_at: '2024-01-01T00:00:00Z' },
    });
    await handleSessionStart(makeInput(repo.repoRoot, 'same-session'));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.context_warning.warned).toBe(true);
  });

  it('last_session_id null (post-resume) → context_warning reset on new session', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: null,
      context_warning: { warned: true, warned_at_pct: 80, warned_at: '2024-01-01T00:00:00Z' },
    });
    await handleSessionStart(makeInput(repo.repoRoot, 'brand-new-session'));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.context_warning.warned).toBe(false);
  });

  it('last_session_id updated in active.json after session start', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'old-sess',
    });
    await handleSessionStart(makeInput(repo.repoRoot, 'new-sess-123'));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.last_session_id).toBe('new-sess-123');
  });

  it('startup + model with [1m] suffix → context_size saved as 1_000_000', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      context_size: 0,
    });
    await handleSessionStart(makeInput(repo.repoRoot, 'sess-new', {
      source: 'startup',
      model: 'claude-sonnet-4-6[1m]',
    }));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.context_size).toBe(1_000_000);
  });

  it('non-startup source → context_size not updated even if model provided', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      context_size: 42,
    });
    await handleSessionStart(makeInput(repo.repoRoot, 'sess-new', {
      source: 'clear',
      model: 'claude-sonnet-4-6[1m]',
    }));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.context_size).toBe(42); // unchanged
  });

  it('startup without model → context_size set to DEFAULT (1M)', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      context_size: 99,
    });
    await handleSessionStart(makeInput(repo.repoRoot, 'sess-new', { source: 'startup' }));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.context_size).toBe(1_000_000);
  });

  it('missing stage prompt file → injects summary without crash', async () => {
    const repo = makeRepo();
    execSync(`rm -f "${join(repo.flowDir, 'stages', 'work.md')}"`, { stdio: 'pipe' });
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-new'));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toContain('test-flow');
  });
});
