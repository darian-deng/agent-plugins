/**
 * PreToolUse hook — control plane protection + stage-scoped path enforcement.
 *
 * Responsibilities:
 *  - Pass through when no active flow
 *  - Hard deny writes to .feat-flow/** (HMAC-protected state)
 *  - Hard deny writes to .claude/plugins/feat-flow/** (plugin files: hooks, stages, lib)
 *  - (legacy .claude/hooks/ no longer used in plugin-mode install)
 *  - Allow reads to .feat-flow/** (AI needs to read status files)
 *  - Stage-scoped path: only allow writes to expected output path per stage
 *  - stage-5 exception: allow writes anywhere (implementation stage)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import {
  createTestRepo,
  writeMarker,
  writeState,
} from './fixtures/helpers.js';
import type { PreToolInput } from '../src/lib/types.js';

import { handlePreToolUse } from '../src/lib/pretool-handler.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function editInput(filePath: string, repoRoot: string, tool = 'Edit'): PreToolInput {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'sess-001',
    cwd: repoRoot,
    tool_name: tool,
    tool_input: { file_path: filePath },
  };
}

function isDenied(result: Awaited<ReturnType<typeof handlePreToolUse>>): boolean {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

// ─── no active flow ────────────────────────────────────────────────────────────

describe('PreToolUse: no active flow', () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => ({ repoRoot, cleanup } = createTestRepo()));
  afterEach(() => cleanup());

  it('any write → pass through (null)', async () => {
    const result = await handlePreToolUse(
      editInput(join(repoRoot, '.feat-flow/state.json'), repoRoot),
    );
    expect(result).toBeNull();
  });
});

// ─── control plane hard deny ──────────────────────────────────────────────────

describe('PreToolUse: control plane protection', () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repoRoot, cleanup } = createTestRepo());
    writeMarker(repoRoot, 'test-flow');
    writeState(repoRoot, { current_stage: 'stage-1' });
  });
  afterEach(() => cleanup());

  const controlPlanePaths = [
    '.feat-flow/state.json',
    '.feat-flow/secret',
    '.feat-flow/gate-token',
    '.feat-flow/transitions.log',
    '.claude/plugins/feat-flow/src/hooks/userprompt.ts',
    '.claude/plugins/feat-flow/src/hooks/new-script.ts',
    '.claude/plugins/feat-flow/helper.md',
    '.claude/plugins/feat-flow/stages/stage-1.md',
    '.claude/plugins/feat-flow/hooks/hooks.json',
  ];

  for (const rel of controlPlanePaths) {
    it(`Edit ${rel} → deny`, async () => {
      const result = await handlePreToolUse(editInput(join(repoRoot, rel), repoRoot));
      expect(isDenied(result)).toBe(true);
      expect(result?.hookSpecificOutput?.permissionDecisionReason).toBeTruthy();
    });

    it(`Write ${rel} → deny`, async () => {
      const result = await handlePreToolUse(editInput(join(repoRoot, rel), repoRoot, 'Write'));
      expect(isDenied(result)).toBe(true);
    });
  }

  it('Read .feat-flow/state.json → allow (AI may read state for context)', async () => {
    const result = await handlePreToolUse(
      editInput(join(repoRoot, '.feat-flow/state.json'), repoRoot, 'Read'),
    );
    expect(isDenied(result)).toBe(false);
  });

  it('Read .feat-flow/gate-token → deny (token must stay invisible to AI)', async () => {
    const result = await handlePreToolUse(
      editInput(join(repoRoot, '.feat-flow/gate-token'), repoRoot, 'Read'),
    );
    expect(isDenied(result)).toBe(true);
  });

  it('Bash tool → pass through (no file_path check)', async () => {
    const result = await handlePreToolUse({
      hook_event_name: 'PreToolUse',
      session_id: 'sess-001',
      cwd: repoRoot,
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(isDenied(result)).toBe(false);
  });
});

// ─── stage-scoped path enforcement ────────────────────────────────────────────

describe('PreToolUse: stage-scoped path enforcement', () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repoRoot, cleanup } = createTestRepo());
    writeMarker(repoRoot, 'test-flow');
  });
  afterEach(() => cleanup());

  it('stage-1: write to docs/feat-flows/ → allow', async () => {
    writeState(repoRoot, { current_stage: 'stage-1', flow_id: 'test-flow' });
    const result = await handlePreToolUse(
      editInput(join(repoRoot, 'docs/feat-flows/test-flow/design.md'), repoRoot),
    );
    expect(isDenied(result)).toBe(false);
  });

  it('stage-1: write to src/ → deny (out of scope)', async () => {
    writeState(repoRoot, { current_stage: 'stage-1', flow_id: 'test-flow' });
    const result = await handlePreToolUse(
      editInput(join(repoRoot, 'src/auth/login.ts'), repoRoot),
    );
    expect(isDenied(result)).toBe(true);
    expect(result?.hookSpecificOutput?.permissionDecisionReason).toMatch(/stage-1/);
  });

  it('stage-5: write to src/ → allow (implementation stage)', async () => {
    writeState(repoRoot, { current_stage: 'stage-5', flow_id: 'test-flow' });
    const result = await handlePreToolUse(
      editInput(join(repoRoot, 'src/auth/login.ts'), repoRoot),
    );
    expect(isDenied(result)).toBe(false);
  });

  it('stage-5: write to docs/adr/ → allow (ADRs always allowed)', async () => {
    writeState(repoRoot, { current_stage: 'stage-2', flow_id: 'test-flow' });
    const result = await handlePreToolUse(
      editInput(join(repoRoot, 'docs/adr/0014-new-decision.md'), repoRoot),
    );
    expect(isDenied(result)).toBe(false);
  });
});
