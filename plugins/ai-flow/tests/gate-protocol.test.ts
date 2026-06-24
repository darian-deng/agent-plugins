import { describe, it, expect, afterEach } from 'vitest';
import { handleStart } from '../src/lib/commands/start.js';
import { advanceStage } from '../src/lib/advance-stage.js';
import { handleSessionStart } from '../src/lib/session-handler.js';
import {
  createFlowTestRepo,
  writeActiveState,
  writeSignal,
  MINIMAL_CONFIG,
  GATED_CONFIG,
  SCRIPTED_CONFIG,
} from './fixtures/helpers.js';
import type { SessionStartInput } from '../src/lib/types.js';

// The engine appends a universal Gate protocol reminder to EVERY gated stage's
// prompt at injection time (start / advance / session recovery), so all flows —
// including ones created later via /ai-flow:create — inherit the "write signal
// before announcing approve" invariant without per-flow stage text.
const GATE_MARKER = 'Gate 协议';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeInput(repoRoot: string, sessionId: string, opts?: Partial<SessionStartInput>): SessionStartInput {
  return { hook_event_name: 'SessionStart', session_id: sessionId, cwd: repoRoot, ...opts };
}

describe('gate protocol injection', () => {
  it('start: gated first stage gets the gate protocol note', async () => {
    const repo = createFlowTestRepo('gated-flow', GATED_CONFIG);
    cleanups.push(repo.cleanup);
    const out = await handleStart(repo.repoRoot, 'gated-flow', 'do X', 'sess-1', 0);
    if (out.action !== 'allow') throw new Error(`expected allow, got ${out.action}`);
    expect(out.additionalContext).toContain(GATE_MARKER);
  });

  it('start: non-gated first stage does NOT get the note', async () => {
    // MINIMAL_CONFIG first stage 'work' has completion {} (no gate)
    const repo = createFlowTestRepo('test-flow', MINIMAL_CONFIG);
    cleanups.push(repo.cleanup);
    const out = await handleStart(repo.repoRoot, 'test-flow', 'do X', 'sess-1', 0);
    if (out.action !== 'allow') throw new Error(`expected allow, got ${out.action}`);
    expect(out.additionalContext).not.toContain(GATE_MARKER);
  });

  it('advance: entering a gated stage gets the note', async () => {
    // MINIMAL_CONFIG: work (no gate) → review (gate)
    const repo = createFlowTestRepo('test-flow', MINIMAL_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'r',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const result = await advanceStage(repo.repoRoot, 'test-flow', 'sess-1');
    expect(result.additionalContext).toContain(GATE_MARKER);
  });

  it('advance: entering a non-gated stage does NOT get the note', async () => {
    // SCRIPTED_CONFIG: work (script) → review (no gate)
    const repo = createFlowTestRepo('scripted-flow', SCRIPTED_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'scripted-flow', {
      flow_id: 'scripted-flow-abc',
      flow_name: 'scripted-flow',
      requirement: 'r',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const result = await advanceStage(repo.repoRoot, 'scripted-flow', 'sess-1');
    expect(result.additionalContext).not.toContain(GATE_MARKER);
  });

  it('session recovery (SESSION_NORMAL) on a gated stage gets the note', async () => {
    const repo = createFlowTestRepo('test-flow', MINIMAL_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'r',
      current_stage: 'review', // gated, no signal written → S0 normal recovery
      base_sha: 'abc',
    });
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-new'));
    expect(out!.additionalContext).toContain(GATE_MARKER);
  });

  it('session recovery with gate ALREADY pending does NOT re-inject the note', async () => {
    // S1+gate: signal is already written, so the "write signal first" reminder
    // would be contradictory. That path emits its own approve-pending message.
    const repo = createFlowTestRepo('test-flow', MINIMAL_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'r',
      current_stage: 'review', // gated + terminal in MINIMAL_CONFIG
      base_sha: 'abc',
    });
    writeSignal(repo.repoRoot, 'test-flow', 'flow-complete'); // gate pending
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-new'));
    expect(out!.additionalContext).toMatch(/approve/i);
    expect(out!.additionalContext).not.toContain(GATE_MARKER);
  });
});
