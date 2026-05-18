/**
 * UserPromptSubmit hook — the main command router.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import {
  createTestRepo,
  writeMarker,
  writeInitRecord,
  writeState,
  writeGateToken,
  makeStage1Design,
} from './fixtures/helpers.js';
import type { UserPromptInput } from '../src/lib/types.js';
import { handleUserPromptSubmit } from '../src/lib/commands/router.js';

function input(prompt: string, repoRoot: string): UserPromptInput {
  return { hook_event_name: 'UserPromptSubmit', session_id: 'sess-001', cwd: repoRoot, prompt: prompt };
}

// ─── feat-flow start ───────────────────────────────────────────────────────────

describe('UserPromptSubmit: feat-flow start', () => {
  let repoRoot: string;
  let pluginDataDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repoRoot, pluginDataDir, cleanup } = createTestRepo());
    writeInitRecord(repoRoot, pluginDataDir);
  });
  afterEach(() => cleanup());

  it('empty requirement → deny with helpful message', async () => {
    const result = await handleUserPromptSubmit(input('feat-flow start', repoRoot));
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/需求描述/);
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/feat-flow start/);
  });

  it('requirement text → allow, injects stage-1 context', async () => {
    const result = await handleUserPromptSubmit(input('feat-flow start 搭建用户登录系统', repoRoot));
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(result.hookSpecificOutput?.additionalContext).toMatch(/stage-1/);
    expect(existsSync(join(repoRoot, '.claude/.feat-flow-active'))).toBe(true);
  });

  it('not-inited project → auto-inits then continues to start validation', async () => {
    // Don't write init record — auto-init should handle it
    const result = await handleUserPromptSubmit(input('feat-flow start 搭建登录系统', repoRoot));
    const reason = result.hookSpecificOutput?.permissionDecisionReason ?? '';
    // Must NOT fail because of missing init
    expect(reason).not.toMatch(/init|setup/i);
  });

  it('active flow already exists → deny and suggest abort', async () => {
    writeMarker(repoRoot, 'existing-flow');
    writeState(repoRoot, { flow_id: 'existing-flow' });
    const result = await handleUserPromptSubmit(input('feat-flow start 新需求', repoRoot));
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/feat-flow abort/);
  });

  it('uncommitted changes → deny (base_sha integrity)', async () => {
    writeFileSync(join(repoRoot, 'dirty.ts'), 'export const x = 1;');
    const result = await handleUserPromptSubmit(input('feat-flow start 搭建登录系统', repoRoot));
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/未提交/);
  });
});

// ─── feat-flow approve ─────────────────────────────────────────────────────────

describe('UserPromptSubmit: feat-flow approve', () => {
  let repoRoot: string;
  let pluginDataDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repoRoot, pluginDataDir, cleanup } = createTestRepo());
    writeInitRecord(repoRoot, pluginDataDir);
    writeMarker(repoRoot, 'test-flow');
    writeState(repoRoot, { flow_id: 'test-flow', current_stage: 'stage-1', waiting_for_gate: true, gate_type: 'stage' });
    writeGateToken(repoRoot, 'abc123def456');
  });
  afterEach(() => cleanup());

  it('correct token → allows, advances stage, injects stage-2 context', async () => {
    const result = await handleUserPromptSubmit(input('feat-flow approve abc123def456', repoRoot));
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(result.hookSpecificOutput?.additionalContext).toMatch(/stage-2/);
    const state = JSON.parse(readFileSync(join(repoRoot, '.feat-flow/state.json'), 'utf-8'));
    expect(state.current_stage).toBe('stage-2');
    expect(state.waiting_for_gate).toBe(false);
  });

  it('wrong token → deny with helpful message', async () => {
    const result = await handleUserPromptSubmit(input('feat-flow approve wrongtoken', repoRoot));
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/token/i);
  });

  it('no active gate → deny', async () => {
    writeState(repoRoot, { flow_id: 'test-flow', current_stage: 'stage-2', waiting_for_gate: false });
    const result = await handleUserPromptSubmit(input('feat-flow approve abc123def456', repoRoot));
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/GATE/);
  });

  it('task-level gate approved → stays on stage-5, clears gate', async () => {
    writeState(repoRoot, { flow_id: 'test-flow', current_stage: 'stage-5', waiting_for_gate: true, gate_type: 'task', gate_context: 'Task 4: delete legacy module' });
    const result = await handleUserPromptSubmit(input('feat-flow approve abc123def456', repoRoot));
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    const state = JSON.parse(readFileSync(join(repoRoot, '.feat-flow/state.json'), 'utf-8'));
    expect(state.current_stage).toBe('stage-5');
    expect(state.waiting_for_gate).toBe(false);
  });
});

// ─── feat-flow abort ───────────────────────────────────────────────────────────

describe('UserPromptSubmit: feat-flow abort', () => {
  let repoRoot: string;
  let pluginDataDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repoRoot, pluginDataDir, cleanup } = createTestRepo());
    writeInitRecord(repoRoot, pluginDataDir);
    writeMarker(repoRoot, 'test-flow');
    writeState(repoRoot, { flow_id: 'test-flow', base_sha: 'abc123' });
    mkdirSync(join(repoRoot, 'docs/feat-flows/test-flow'), { recursive: true });
    writeFileSync(join(repoRoot, 'docs/feat-flows/test-flow/design.md'), makeStage1Design());
  });
  afterEach(() => cleanup());

  it('no active flow → deny', async () => {
    require('fs').rmSync(join(repoRoot, '.claude/.feat-flow-active'));
    const result = await handleUserPromptSubmit(input('feat-flow abort', repoRoot));
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/活跃 flow/);
  });

  it('active flow → creates abort branch, clears marker', async () => {
    const result = await handleUserPromptSubmit(input('feat-flow abort', repoRoot));
    expect(existsSync(join(repoRoot, '.claude/.feat-flow-active'))).toBe(false);
    const branches = require('child_process').execSync('git branch', { cwd: repoRoot }).toString();
    expect(branches).toMatch(/feat-flow\/aborted-/);
    expect(result.hookSpecificOutput?.additionalContext).toMatch(/aborted/);
  });
});

// ─── feat-flow status ──────────────────────────────────────────────────────────

describe('UserPromptSubmit: feat-flow status', () => {
  let repoRoot: string;
  let pluginDataDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repoRoot, pluginDataDir, cleanup } = createTestRepo());
    writeInitRecord(repoRoot, pluginDataDir);
  });
  afterEach(() => cleanup());

  it('no active flow → injects "no active flow" message', async () => {
    const result = await handleUserPromptSubmit(input('feat-flow status', repoRoot));
    expect(result.hookSpecificOutput?.additionalContext).toMatch(/无活跃|no active flow/i);
  });

  it('active flow → injects current stage', async () => {
    writeMarker(repoRoot, 'test-flow');
    writeState(repoRoot, { flow_id: 'test-flow', current_stage: 'stage-3', waiting_for_gate: false });
    const result = await handleUserPromptSubmit(input('feat-flow status', repoRoot));
    expect(result.hookSpecificOutput?.additionalContext).toMatch(/stage-3/);
  });

  it('active gate → includes token retrieval hint', async () => {
    writeMarker(repoRoot, 'test-flow');
    writeState(repoRoot, { flow_id: 'test-flow', current_stage: 'stage-1', waiting_for_gate: true });
    writeGateToken(repoRoot, 'abc123');
    const result = await handleUserPromptSubmit(input('feat-flow status', repoRoot));
    expect(result.hookSpecificOutput?.additionalContext).toMatch(/gate-token|approve/i);
  });
});

// ─── feat-flow help ────────────────────────────────────────────────────────────

describe('UserPromptSubmit: feat-flow help', () => {
  let repoRoot: string;
  let pluginDataDir: string;
  let cleanup: () => void;

  beforeEach(() => ({ repoRoot, pluginDataDir, cleanup } = createTestRepo()));
  afterEach(() => cleanup());

  it('returns all 7 commands in context', async () => {
    const result = await handleUserPromptSubmit(input('feat-flow help', repoRoot));
    const ctx = result.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toMatch(/feat-flow init/);
    expect(ctx).toMatch(/feat-flow start/);
    expect(ctx).toMatch(/feat-flow approve/);
    expect(ctx).toMatch(/feat-flow abort/);
    expect(ctx).toMatch(/feat-flow resume/);
    expect(ctx).toMatch(/feat-flow status/);
    expect(ctx).toMatch(/feat-flow help/);
  });
});

// ─── unknown command ───────────────────────────────────────────────────────────

describe('UserPromptSubmit: unknown command', () => {
  let repoRoot: string;
  let pluginDataDir: string;
  let cleanup: () => void;

  beforeEach(() => ({ repoRoot, pluginDataDir, cleanup } = createTestRepo()));
  afterEach(() => cleanup());

  it('unknown subcommand → deny with command list', async () => {
    const result = await handleUserPromptSubmit(input('feat-flow foobar', repoRoot));
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/feat-flow start/);
  });
});

// ─── GATE waiting enforcement ──────────────────────────────────────────────────

describe('UserPromptSubmit: GATE waiting enforcement', () => {
  let repoRoot: string;
  let pluginDataDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repoRoot, pluginDataDir, cleanup } = createTestRepo());
    writeInitRecord(repoRoot, pluginDataDir);
    writeMarker(repoRoot, 'test-flow');
    writeGateToken(repoRoot, 'abc123def456');
  });
  afterEach(() => cleanup());

  it('waiting_for_gate + non-approve message → allowed (GATE is non-blocking)', async () => {
    writeState(repoRoot, { flow_id: 'test-flow', current_stage: 'stage-1', waiting_for_gate: true, gate_type: 'stage' });
    const result = await handleUserPromptSubmit(input('可以帮我看下这段代码吗', repoRoot));
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });
});

// ─── helper context injection ──────────────────────────────────────────────────

describe('UserPromptSubmit: helper context injection', () => {
  let repoRoot: string;
  let pluginDataDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repoRoot, pluginDataDir, cleanup } = createTestRepo());
    writeInitRecord(repoRoot, pluginDataDir);
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

// ─── feat-flow resume ──────────────────────────────────────────────────────────

describe('UserPromptSubmit: feat-flow resume', () => {
  let repoRoot: string;
  let pluginDataDir: string;
  let cleanup: () => void;
  let abortBranch: string;

  beforeEach(() => {
    ({ repoRoot, pluginDataDir, cleanup } = createTestRepo());
    writeInitRecord(repoRoot, pluginDataDir);
    abortBranch = 'feat-flow/aborted-2026-01-01T00-00-00';

    const exec = (cmd: string) =>
      require('child_process').execSync(cmd, { cwd: repoRoot, stdio: 'pipe' });
    exec(`git checkout -b ${abortBranch}`);
    mkdirSync(join(repoRoot, 'docs/feat-flows/test-flow'), { recursive: true });
    writeFileSync(
      join(repoRoot, 'docs/feat-flows/test-flow/state-snapshot.json'),
      JSON.stringify({
        flow_id: 'test-flow', requirement: 'test requirement', current_stage: 'stage-3',
        base_sha: 'abc123', started_at: '2026-01-01T00:00:00Z', last_session_id: null,
        context_size: 1_000_000, stage_progress: {}, waiting_for_gate: false,
        gate_type: null, gate_context: null, expected_next: 'begin stage-3',
        context_warning: { warned: false, warned_at_pct: null, warned_at: null },
        approved_task_gates: [], _note: 'snapshot',
      }),
    );
    exec('git add -A');
    exec(`git commit -m "feat-flow: abort test-flow"`);
    exec('git checkout -');
  });
  afterEach(() => cleanup());

  it('valid branch + snapshot → restores flow, injects stage context', async () => {
    const result = await handleUserPromptSubmit(input(`feat-flow resume ${abortBranch}`, repoRoot));
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(result.hookSpecificOutput?.additionalContext).toMatch(/stage-3/);
    expect(existsSync(join(repoRoot, '.claude/.feat-flow-active'))).toBe(true);
    const state = JSON.parse(readFileSync(join(repoRoot, '.feat-flow/state.json'), 'utf-8'));
    expect(state.current_stage).toBe('stage-3');
  });

  it('no branch name → deny with usage hint', async () => {
    const result = await handleUserPromptSubmit(input('feat-flow resume', repoRoot));
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/branch/i);
  });

  it('branch does not exist → deny', async () => {
    const result = await handleUserPromptSubmit(input('feat-flow resume feat-flow/aborted-nonexistent', repoRoot));
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/存在|exist/i);
  });

  it('branch exists but no snapshot → deny', async () => {
    require('child_process').execSync('git checkout -b feat-flow/no-snapshot', { cwd: repoRoot, stdio: 'pipe' });
    require('child_process').execSync('git checkout -', { cwd: repoRoot, stdio: 'pipe' });
    const result = await handleUserPromptSubmit(input('feat-flow resume feat-flow/no-snapshot', repoRoot));
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/snapshot/i);
  });
});
