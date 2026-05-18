/**
 * SessionStart hook — state restoration across sessions.
 *
 * Responsibilities:
 *  - Pass through when no active marker
 *  - Detect new session_id (after /clear) → reset context warning
 *  - Validate HMAC; warn if mismatch
 *  - Inject current stage context + expected_next
 *  - If waiting_for_gate → inject gate reminder with token retrieval hint
 *  - Update model → context_size in state if model provided
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import {
  createTestRepo,
  writeMarker,
  writeState,
  writeGateToken,
} from './fixtures/helpers.js';
import type { SessionStartInput } from '../src/lib/types.js';

import { handleSessionStart } from '../src/lib/session-handler.js';

function input(repoRoot: string, overrides: Partial<SessionStartInput> = {}): SessionStartInput {
  return {
    hook_event_name: 'SessionStart',
    session_id: 'sess-new-001',
    cwd: repoRoot,
    model: 'claude-sonnet-4-6',
    ...overrides,
  };
}

// ─── no active flow ────────────────────────────────────────────────────────────

describe('SessionStart: no active flow', () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => ({ repoRoot, cleanup } = createTestRepo()));
  afterEach(() => cleanup());

  it('no marker → null output', async () => {
    const result = await handleSessionStart(input(repoRoot));
    expect(result).toBeNull();
  });
});

// ─── state restoration ────────────────────────────────────────────────────────

describe('SessionStart: state restoration', () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repoRoot, cleanup } = createTestRepo());
    writeMarker(repoRoot, 'test-flow');
  });
  afterEach(() => cleanup());

  it('injects current stage and expected_next', async () => {
    writeState(repoRoot, {
      current_stage: 'stage-3',
      expected_next: 'dispatch architect subagents',
      waiting_for_gate: false,
      last_session_id: 'sess-old-001',
    });
    const result = await handleSessionStart(input(repoRoot));
    expect(result?.hookSpecificOutput?.additionalContext).toMatch(/stage-3/);
    expect(result?.hookSpecificOutput?.additionalContext).toMatch(/architect/);
  });

  it('waiting_for_gate=true → injects gate reminder with token hint', async () => {
    writeState(repoRoot, {
      current_stage: 'stage-1',
      waiting_for_gate: true,
      gate_type: 'stage',
      last_session_id: 'sess-old-001',
    });
    writeGateToken(repoRoot, 'abc123def456');
    const result = await handleSessionStart(input(repoRoot));
    expect(result?.hookSpecificOutput?.additionalContext).toMatch(/feat-flow approve/);
    expect(result?.hookSpecificOutput?.additionalContext).toMatch(/gate-token/);
  });
});

// ─── new session_id detection ─────────────────────────────────────────────────

describe('SessionStart: session change resets context warning', () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repoRoot, cleanup } = createTestRepo());
    writeMarker(repoRoot, 'test-flow');
  });
  afterEach(() => cleanup());

  it('new session_id → context_warning reset in state.json', async () => {
    writeState(repoRoot, {
      current_stage: 'stage-5',
      last_session_id: 'sess-old-001',
      context_warning: { warned: true, warned_at_pct: 42, warned_at: '2026-01-01T00:00:00Z' },
    });
    await handleSessionStart(input(repoRoot, { session_id: 'sess-new-999' }));
    const state = JSON.parse(
      require('fs').readFileSync(join(repoRoot, '.feat-flow/state.json'), 'utf-8'),
    );
    expect(state.context_warning.warned).toBe(false);
    expect(state.context_warning.warned_at_pct).toBeNull();
    expect(state.last_session_id).toBe('sess-new-999');
  });

  it('same session_id (reconnect) → context_warning NOT reset', async () => {
    writeState(repoRoot, {
      current_stage: 'stage-5',
      last_session_id: 'sess-same-001',
      context_warning: { warned: true, warned_at_pct: 42, warned_at: '2026-01-01T00:00:00Z' },
    });
    await handleSessionStart(input(repoRoot, { session_id: 'sess-same-001' }));
    const state = JSON.parse(
      require('fs').readFileSync(join(repoRoot, '.feat-flow/state.json'), 'utf-8'),
    );
    expect(state.context_warning.warned).toBe(true);
  });
});

// HMAC validation removed — secret + HMAC deemed unnecessary.
// Security is provided by token mechanism + PreToolUse write protection.
