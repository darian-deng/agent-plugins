import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { handleSessionStart } from '../src/lib/session-handler.js';
import { readActiveState } from '../src/lib/state.js';
import { createFlowTestRepo, writeActiveState, writeSignal, MINIMAL_CONFIG, GATED_CONFIG } from './fixtures/helpers.js';
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

  it('active flow with gate pending (S1 + gate) → additionalContext mentions approve', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'review', // review has gate: true in MINIMAL_CONFIG
      base_sha: 'abc',
    });
    // MINIMAL_CONFIG: review is last stage (terminal), so signal must be 'flow-complete'
    writeSignal(repo.repoRoot, 'test-flow', 'flow-complete');
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-new'));
    expect(out!.additionalContext).toMatch(/gate|approve/i);
  });

  it("S1 self-heal: signal='done' + non-gate stage → stage advances, next stage injected", async () => {
    // Crash scenario: AI wrote 'done' but posttool didn't process it yet
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
    });
    writeSignal(repo.repoRoot, 'test-flow', 'done');
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-new'));
    expect(out).not.toBeNull();
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('review');
    expect(out!.additionalContext).toContain('review');
  });

  it('flow-complete signal at terminal (S2 self-heal) → active.json deleted', async () => {
    const repo = createFlowTestRepo('test-flow', {
      schema_version: '1.0',
      name: 'test-flow',
      stages: [
        { id: 'work', prompt: 'stages/work.md', write_scope: 'unrestricted', completion: {} },
        { id: 'review', prompt: 'stages/review.md', write_scope: 'unrestricted', completion: {} },
      ],
    });
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'review', // last stage
      base_sha: 'abc',
    });
    writeSignal(repo.repoRoot, 'test-flow', 'flow-complete');
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-new'));
    expect(out).not.toBeNull();
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).toBeNull();
    expect(out!.additionalContext).toMatch(/complete|完成/i);
  });

  it('stale signal (S3) → normal recovery, current stage injected', async () => {
    // Signal content doesn't match nextStage → treat as normal recovery
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
    });
    // Write stale/wrong signal content
    writeSignal(repo.repoRoot, 'test-flow', 'stale-content');
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-new'));
    expect(out).not.toBeNull();
    // Should stay at 'work', inject current stage prompt
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('work');
    expect(out!.additionalContext).toContain('work');
    expect(out!.additionalContext).toContain('Stage: work');
  });

  it('new session → context_warning reset in state', async () => {
    const repo = makeRepo();
    // last_session_id: null represents a cleanly ended prior session (SessionEnd cleared it)
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: null,
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
    // null = prior session ended cleanly; new session may claim ownership
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: null,
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

  it('new session → context_blocked reset to false in state', async () => {
    const repo = makeRepo();
    // null = prior session ended cleanly; new session may claim ownership
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: null,
      context_blocked: true,
      context_warning: { warned: true, warned_at_pct: 70, warned_at: '2024-01-01T00:00:00Z' },
    });
    await handleSessionStart(makeInput(repo.repoRoot, 'new-session'));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.context_blocked).toBe(false);
  });

  it('same session → context_blocked NOT reset', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'same-session',
      context_blocked: true,
      context_warning: { warned: true, warned_at_pct: 70, warned_at: '2024-01-01T00:00:00Z' },
    });
    await handleSessionStart(makeInput(repo.repoRoot, 'same-session'));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.context_blocked).toBe(true);
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

  // ── Session mutex ──────────────────────────────────────────────────────────

  it('different session owns flow → read-only context, no stage prompt, state unchanged', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'owner-session',
    });
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'intruder-session'));
    expect(out).not.toBeNull();
    // Read-only notice: names the flow, states the modify ban, points at recovery.
    expect(out!.additionalContext).toContain('test-flow');
    expect(out!.additionalContext).toMatch(/只读|仅可读取|禁止修改/);
    expect(out!.additionalContext).toContain('last_session_id');
    // Must NOT inject the stage prompt body — the observer must not drive the flow.
    expect(out!.additionalContext).not.toContain('Do the work.');
    // State must NOT be modified — owner session id preserved and intruder not in history.
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.last_session_id).toBe('owner-session');
    expect(state!.history_session_ids ?? []).not.toContain('intruder-session');
  });

  it('same session re-enters → no mutex block', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'owner-session',
    });
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'owner-session'));
    // Should not contain block message — use a stable marker, not the Chinese wording
    expect(out!.additionalContext).not.toContain('last_session_id');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.last_session_id).toBe('owner-session');
  });

  it('history_session_ids accumulates across sessions', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: null,
    });
    await handleSessionStart(makeInput(repo.repoRoot, 'sess-a'));
    // Simulate clean handoff: SessionEnd would set last_session_id to null
    writeActiveState(repo.repoRoot, 'test-flow', {
      ...(await readActiveState(repo.repoRoot, 'test-flow'))!,
      last_session_id: null,
    });
    await handleSessionStart(makeInput(repo.repoRoot, 'sess-b'));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.history_session_ids).toContain('sess-a');
    expect(state!.history_session_ids).toContain('sess-b');
  });

  it('same session re-entry does not duplicate in history_session_ids', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'sess-a',
      history_session_ids: ['sess-a'],
    });
    await handleSessionStart(makeInput(repo.repoRoot, 'sess-a'));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.history_session_ids!.filter((s) => s === 'sess-a').length).toBe(1);
  });

  // ── New protocol: AI writes 'done', session self-heal handles it ──

  it("signal='done' + non-gate stage → self-heal advances to next stage", async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow',
      requirement: 'build', current_stage: 'work', base_sha: 'abc',
    });
    writeSignal(repo.repoRoot, 'test-flow', 'done');
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-new'));
    expect(out).not.toBeNull();
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('review');
    expect(out!.additionalContext).toContain('review');
  });

  it("signal='done' + gate stage → session shows gate pending recovery", async () => {
    // GATED_CONFIG: work has gate=true
    const repo = createFlowTestRepo('test-flow', GATED_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow',
      requirement: 'build', current_stage: 'work', base_sha: 'abc',
    });
    writeSignal(repo.repoRoot, 'test-flow', 'done');
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-new'));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toMatch(/gate|approve/i);
    // Stage should NOT have advanced
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('work');
  });
});
