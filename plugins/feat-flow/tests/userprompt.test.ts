/**
 * UserPromptSubmit hook — the main command router.
 *
 * Responsibilities:
 *  - Detect `feat-flow <subcommand>` and route to handlers
 *  - Block unknown commands with usage hint
 *  - Enforce setup check on start/resume
 *  - Enforce GATE waiting (block non-approve messages)
 *  - Inject helper context reminder on every feat-flow command
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import {
  createTestRepo,
  writeMarker,
  writeSetupMarker,
  writeState,
  writeGateToken,
  makeStage1Design,
} from './fixtures/helpers.js';
import type { UserPromptInput } from '../src/lib/types.js';

// The function under test – thin wrapper reads stdin, we call the handler directly.
// Import will fail until implemented; that's expected (TDD red phase).
import { handleUserPromptSubmit } from '../src/lib/commands/router.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function input(prompt: string, repoRoot: string): UserPromptInput {
  return {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'sess-001',
    cwd: repoRoot,
    user_prompt: prompt,
  };
}

// ─── test suite ───────────────────────────────────────────────────────────────

describe('UserPromptSubmit: feat-flow start', () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repoRoot, cleanup } = createTestRepo());
    writeSetupMarker(repoRoot);
  });
  afterEach(() => cleanup());

  it('empty requirement → deny with helpful message', async () => {
    const result = await handleUserPromptSubmit(input('feat-flow start', repoRoot));
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/需求描述/);
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/feat-flow start/);
  });

  it('requirement text (no quotes needed) → allow, injects stage-1 context', async () => {
    const result = await handleUserPromptSubmit(
      input('feat-flow start 搭建用户登录系统', repoRoot),
    );
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(result.hookSpecificOutput?.additionalContext).toMatch(/stage-1/);
    // .feat-flow-active marker must be created
    const marker = join(repoRoot, '.claude/.feat-flow-active');
    expect(() => require('fs').readFileSync(marker)).not.toThrow();
  });

  it('setup not done → deny and explain', async () => {
    // Remove the setup marker
    require('fs').rmSync(join(repoRoot, '.feat-flow/.initialized'));
    const result = await handleUserPromptSubmit(
      input('feat-flow start 搭建登录系统', repoRoot),
    );
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/feat-flow-setup/);
  });

  it('active flow already exists → deny and suggest abort', async () => {
    writeMarker(repoRoot, 'existing-flow');
    writeState(repoRoot, { flow_id: 'existing-flow' });
    const result = await handleUserPromptSubmit(
      input('feat-flow start 新需求', repoRoot),
    );
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/feat-flow abort/);
  });

  it('uncommitted changes in working tree → deny (base_sha integrity)', async () => {
    writeFileSync(join(repoRoot, 'dirty.ts'), 'export const x = 1;');
    const result = await handleUserPromptSubmit(
      input('feat-flow start 搭建登录系统', repoRoot),
    );
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/未提交/);
  });

  it('not a git repo → deny', async () => {
    // Use a non-git temp dir
    const { repoRoot: bare, cleanup: c } = createTestRepo();
    require('fs').rmSync(join(bare, '.git'), { recursive: true });
    writeSetupMarker(bare);
    const result = await handleUserPromptSubmit(input('feat-flow start 测试', bare));
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/git/);
    c();
  });
});

describe('UserPromptSubmit: feat-flow approve', () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repoRoot, cleanup } = createTestRepo());
    writeSetupMarker(repoRoot);
    writeMarker(repoRoot, 'test-flow');
    writeState(repoRoot, {
      flow_id: 'test-flow',
      current_stage: 'stage-1',
      waiting_for_gate: true,
      gate_type: 'stage',
    });
    writeGateToken(repoRoot, 'abc123def456');
  });
  afterEach(() => cleanup());

  it('correct token → allows, advances stage, injects stage-2 context', async () => {
    const result = await handleUserPromptSubmit(
      input('feat-flow approve abc123def456', repoRoot),
    );
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(result.hookSpecificOutput?.additionalContext).toMatch(/stage-2/);
    // state.json must reflect stage-2
    const state = JSON.parse(
      require('fs').readFileSync(join(repoRoot, '.feat-flow/state.json'), 'utf-8'),
    );
    expect(state.current_stage).toBe('stage-2');
    expect(state.waiting_for_gate).toBe(false);
  });

  it('wrong token → deny with helpful message', async () => {
    const result = await handleUserPromptSubmit(
      input('feat-flow approve wrongtoken', repoRoot),
    );
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/token/i);
  });

  it('no active gate → deny with explanation', async () => {
    writeState(repoRoot, {
      flow_id: 'test-flow',
      current_stage: 'stage-2',
      waiting_for_gate: false,
    });
    const result = await handleUserPromptSubmit(
      input('feat-flow approve abc123def456', repoRoot),
    );
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/GATE/);
  });

  it('task-level gate approved → stays on stage-5, clears gate', async () => {
    writeState(repoRoot, {
      flow_id: 'test-flow',
      current_stage: 'stage-5',
      waiting_for_gate: true,
      gate_type: 'task',
      gate_context: 'Task 4: delete legacy module',
    });
    const result = await handleUserPromptSubmit(
      input('feat-flow approve abc123def456', repoRoot),
    );
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    const state = JSON.parse(
      require('fs').readFileSync(join(repoRoot, '.feat-flow/state.json'), 'utf-8'),
    );
    // stage does NOT advance for task-level gate
    expect(state.current_stage).toBe('stage-5');
    expect(state.waiting_for_gate).toBe(false);
  });
});

describe('UserPromptSubmit: feat-flow abort', () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repoRoot, cleanup } = createTestRepo());
    writeSetupMarker(repoRoot);
    writeMarker(repoRoot, 'test-flow');
    writeState(repoRoot, { flow_id: 'test-flow', base_sha: 'abc123' });
    mkdirSync(join(repoRoot, 'docs/feat-flows/test-flow'), { recursive: true });
    writeFileSync(join(repoRoot, 'docs/feat-flows/test-flow/design.md'), makeStage1Design());
  });
  afterEach(() => cleanup());

  it('no active flow → deny with explanation', async () => {
    require('fs').rmSync(join(repoRoot, '.claude/.feat-flow-active'));
    const result = await handleUserPromptSubmit(input('feat-flow abort', repoRoot));
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/活跃 flow/);
  });

  it('active flow → creates abort branch, clears marker, injects confirmation', async () => {
    const result = await handleUserPromptSubmit(input('feat-flow abort', repoRoot));
    // marker removed
    expect(require('fs').existsSync(join(repoRoot, '.claude/.feat-flow-active'))).toBe(false);
    // abort branch created
    const branches = require('child_process')
      .execSync('git branch', { cwd: repoRoot })
      .toString();
    expect(branches).toMatch(/feat-flow\/aborted-/);
    // context injected
    expect(result.hookSpecificOutput?.additionalContext).toMatch(/aborted/);
  });
});

describe('UserPromptSubmit: feat-flow status', () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repoRoot, cleanup } = createTestRepo());
    writeSetupMarker(repoRoot);
  });
  afterEach(() => cleanup());

  it('no active flow → injects "no active flow" message', async () => {
    const result = await handleUserPromptSubmit(input('feat-flow status', repoRoot));
    expect(result.hookSpecificOutput?.additionalContext).toMatch(/진행 중인 flow 없음|no active flow|无活跃/i);
  });

  it('active flow → injects current stage, progress, gate status', async () => {
    writeMarker(repoRoot, 'test-flow');
    writeState(repoRoot, {
      flow_id: 'test-flow',
      current_stage: 'stage-3',
      waiting_for_gate: false,
    });
    const result = await handleUserPromptSubmit(input('feat-flow status', repoRoot));
    expect(result.hookSpecificOutput?.additionalContext).toMatch(/stage-3/);
  });

  it('active gate → includes token retrieval hint', async () => {
    writeMarker(repoRoot, 'test-flow');
    writeState(repoRoot, {
      flow_id: 'test-flow',
      current_stage: 'stage-1',
      waiting_for_gate: true,
    });
    writeGateToken(repoRoot, 'abc123');
    const result = await handleUserPromptSubmit(input('feat-flow status', repoRoot));
    expect(result.hookSpecificOutput?.additionalContext).toMatch(/gate-token|approve/i);
  });
});

describe('UserPromptSubmit: feat-flow help', () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repoRoot, cleanup } = createTestRepo());
  });
  afterEach(() => cleanup());

  it('always available, returns all 6 commands in context', async () => {
    const result = await handleUserPromptSubmit(input('feat-flow help', repoRoot));
    const ctx = result.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toMatch(/feat-flow start/);
    expect(ctx).toMatch(/feat-flow approve/);
    expect(ctx).toMatch(/feat-flow abort/);
    expect(ctx).toMatch(/feat-flow resume/);
    expect(ctx).toMatch(/feat-flow status/);
    expect(ctx).toMatch(/feat-flow help/);
  });
});

describe('UserPromptSubmit: unknown command', () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repoRoot, cleanup } = createTestRepo());
  });
  afterEach(() => cleanup());

  it('unknown subcommand → deny with command list', async () => {
    const result = await handleUserPromptSubmit(
      input('feat-flow foobar', repoRoot),
    );
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/feat-flow start/);
  });
});

describe('UserPromptSubmit: GATE waiting enforcement', () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repoRoot, cleanup } = createTestRepo());
    writeSetupMarker(repoRoot);
    writeMarker(repoRoot, 'test-flow');
    writeGateToken(repoRoot, 'abc123def456');
  });
  afterEach(() => cleanup());

  it('waiting_for_gate=true + non-approve message → allowed (GATE is non-blocking)', async () => {
    // GATE does not block conversation — user may still talk to AI to verify
    // quality, and approves when satisfied. Only feat-flow approve is special.
    writeState(repoRoot, {
      flow_id: 'test-flow',
      current_stage: 'stage-1',
      waiting_for_gate: true,
      gate_type: 'stage',
    });
    const result = await handleUserPromptSubmit(
      input('可以帮我看下这段代码吗', repoRoot),
    );
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  it('waiting_for_gate=false + normal message → allow with no extra injection', async () => {
    writeState(repoRoot, {
      flow_id: 'test-flow',
      current_stage: 'stage-2',
      waiting_for_gate: false,
    });
    const result = await handleUserPromptSubmit(
      input('继续探索代码库', repoRoot),
    );
    // Normal messages just pass through — no injection, no block
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });
});

describe('UserPromptSubmit: helper context injection', () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repoRoot, cleanup } = createTestRepo());
    writeSetupMarker(repoRoot);
    writeMarker(repoRoot, 'test-flow');
    writeState(repoRoot, { flow_id: 'test-flow', current_stage: 'stage-2', waiting_for_gate: false });
  });
  afterEach(() => cleanup());

  it('every feat-flow command injects helper.md path', async () => {
    for (const cmd of ['feat-flow help', 'feat-flow status']) {
      const result = await handleUserPromptSubmit(input(cmd, repoRoot));
      expect(result.hookSpecificOutput?.additionalContext).toMatch(/helper\.md/);
    }
  });
});

describe('UserPromptSubmit: feat-flow resume', () => {
  let repoRoot: string;
  let cleanup: () => void;
  let abortBranch: string;

  beforeEach(() => {
    ({ repoRoot, cleanup } = createTestRepo());
    writeSetupMarker(repoRoot);
    abortBranch = 'feat-flow/aborted-2026-01-01T00-00-00';

    // Create abort branch with state-snapshot.json
    const exec = (cmd: string) =>
      require('child_process').execSync(cmd, { cwd: repoRoot, stdio: 'pipe' });
    exec(`git checkout -b ${abortBranch}`);
    mkdirSync(join(repoRoot, 'docs/feat-flows/test-flow'), { recursive: true });
    writeFileSync(
      join(repoRoot, 'docs/feat-flows/test-flow/state-snapshot.json'),
      JSON.stringify({
        flow_id: 'test-flow',
        requirement: 'test requirement',
        current_stage: 'stage-3',
        base_sha: 'abc123',
        started_at: '2026-01-01T00:00:00Z',
        last_session_id: null,
        context_size: 1_000_000,
        stage_progress: {},
        waiting_for_gate: false,
        gate_type: null,
        gate_context: null,
        expected_next: 'begin stage-3',
        context_warning: { warned: false, warned_at_pct: null, warned_at: null },
        approved_task_gates: [],
        _note: 'snapshot',
      }),
    );
    exec('git add -A');
    exec(`git commit -m "feat-flow: abort test-flow"`);
    exec('git checkout -'); // back to main/original branch
  });
  afterEach(() => cleanup());

  it('valid branch + snapshot → restores flow, injects stage context', async () => {
    const result = await handleUserPromptSubmit(
      input(`feat-flow resume ${abortBranch}`, repoRoot),
    );
    // Must not deny
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    // Must inject context with current_stage
    expect(result.hookSpecificOutput?.additionalContext).toMatch(/stage-3/);
    // Marker must exist
    expect(existsSync(join(repoRoot, '.claude/.feat-flow-active'))).toBe(true);
    // State must reflect snapshot
    const state = JSON.parse(
      readFileSync(join(repoRoot, '.feat-flow/state.json'), 'utf-8'),
    );
    expect(state.current_stage).toBe('stage-3');
    expect(state.flow_id).toBe('test-flow');
  });

  it('no branch name → deny with usage hint', async () => {
    const result = await handleUserPromptSubmit(input('feat-flow resume', repoRoot));
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/branch/i);
  });

  it('branch does not exist → deny with clear error', async () => {
    const result = await handleUserPromptSubmit(
      input('feat-flow resume feat-flow/aborted-nonexistent', repoRoot),
    );
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/存在|exist/i);
  });

  it('branch exists but no state-snapshot.json → deny with explanation', async () => {
    // Create a branch without a snapshot
    require('child_process').execSync('git checkout -b feat-flow/no-snapshot', {
      cwd: repoRoot, stdio: 'pipe',
    });
    require('child_process').execSync('git checkout -', { cwd: repoRoot, stdio: 'pipe' });

    const result = await handleUserPromptSubmit(
      input('feat-flow resume feat-flow/no-snapshot', repoRoot),
    );
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/snapshot/i);
  });
});
