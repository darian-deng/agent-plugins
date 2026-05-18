/**
 * PostToolUse hook — stage completion detection + context window monitoring.
 *
 * Responsibilities:
 *  - Only fire during active feat-flow session
 *  - Detect stage completion via anchor patterns in output files
 *  - On GATE stages: generate token, set waiting_for_gate, notify user
 *  - On auto-advance stages: update current_stage in state.json
 *  - Detect task-level [GATE] in plan.md
 *  - Detect AI-requested ## GATE-REQUEST: pattern
 *  - Monitor context window via JSONL transcript, warn at 35% and 55%
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import {
  createTestRepo,
  writeMarker,
  writeState,
  makeStage1Design,
  makePlanMd,
} from './fixtures/helpers.js';
import type { PostToolInput } from '../src/lib/types.js';

import { handlePostToolUse } from '../src/lib/posttool-handler.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function editInput(filePath: string, repoRoot: string): PostToolInput {
  return {
    hook_event_name: 'PostToolUse',
    session_id: 'sess-001',
    cwd: repoRoot,
    tool_name: 'Edit',
    tool_input: { file_path: filePath },
    tool_result: { success: true },
  };
}

function readState(repoRoot: string) {
  return JSON.parse(
    require('fs').readFileSync(join(repoRoot, '.feat-flow/state.json'), 'utf-8'),
  );
}

// ─── routing ──────────────────────────────────────────────────────────────────

describe('PostToolUse: routing', () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repoRoot, cleanup } = createTestRepo());
    writeMarker(repoRoot, 'test-flow');
    writeState(repoRoot, { current_stage: 'stage-1' });
  });
  afterEach(() => cleanup());

  it('no active marker → exit (null output)', async () => {
    require('fs').rmSync(join(repoRoot, '.claude/.feat-flow-active'));
    const result = await handlePostToolUse(editInput('/any/file', repoRoot));
    expect(result).toBeNull();
  });

  it('non Edit/Write tool (Bash) → null output', async () => {
    const bashInput: PostToolInput = {
      ...editInput('/any/file', repoRoot),
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    };
    const result = await handlePostToolUse(bashInput);
    expect(result).toBeNull();
  });

  it('already waiting_for_gate → null output (no re-trigger)', async () => {
    writeState(repoRoot, { current_stage: 'stage-1', waiting_for_gate: true });
    const designMd = join(repoRoot, 'docs/feat-flows/test-flow/design.md');
    mkdirSync(join(repoRoot, 'docs/feat-flows/test-flow'), { recursive: true });
    writeFileSync(designMd, makeStage1Design());
    const result = await handlePostToolUse(editInput(designMd, repoRoot));
    expect(result).toBeNull();
  });
});

// ─── stage-1 ──────────────────────────────────────────────────────────────────

describe('PostToolUse: stage-1 completion', () => {
  let repoRoot: string;
  let cleanup: () => void;
  let designMd: string;

  beforeEach(() => {
    ({ repoRoot, cleanup } = createTestRepo());
    writeMarker(repoRoot, 'test-flow');
    writeState(repoRoot, { current_stage: 'stage-1' });
    mkdirSync(join(repoRoot, 'docs/feat-flows/test-flow'), { recursive: true });
    designMd = join(repoRoot, 'docs/feat-flows/test-flow/design.md');
  });
  afterEach(() => cleanup());

  it('missing ## 验收标准 → no trigger', async () => {
    writeFileSync(designMd, '## 需求\nSome content.\n\n## STAGE-1-COMPLETE\nDone.');
    const result = await handlePostToolUse(editInput(designMd, repoRoot));
    expect(result).toBeNull();
  });

  it('missing ## STAGE-1-COMPLETE → no trigger', async () => {
    writeFileSync(designMd, '## 需求\nContent.\n\n## 验收标准\nAC1.');
    const result = await handlePostToolUse(editInput(designMd, repoRoot));
    expect(result).toBeNull();
  });

  it('word count < 200 → no trigger', async () => {
    writeFileSync(designMd, '## 需求\nShort.\n\n## 验收标准\nAC.\n\n## STAGE-1-COMPLETE\nDone.');
    const result = await handlePostToolUse(editInput(designMd, repoRoot));
    expect(result).toBeNull();
  });

  it('all anchors + 200+ words → GATE triggered', async () => {
    writeFileSync(designMd, makeStage1Design());
    const result = await handlePostToolUse(editInput(designMd, repoRoot));
    expect(result).not.toBeNull();
    expect(result?.hookSpecificOutput?.hookEventName).toBe('PostToolUse');
    // state updated
    const state = readState(repoRoot);
    expect(state.waiting_for_gate).toBe(true);
    expect(state.gate_type).toBe('stage');
    // token file created
    expect(existsSync(join(repoRoot, '.feat-flow/gate-token'))).toBe(true);
  });

  it('GATE output includes token-retrieval hint in systemMessage', async () => {
    writeFileSync(designMd, makeStage1Design());
    const result = await handlePostToolUse(editInput(designMd, repoRoot));
    expect(result?.systemMessage).toMatch(/gate-token/);
    expect(result?.systemMessage).toMatch(/feat-flow approve/);
  });

  it('GATE additionalContext tells AI to stop and explain', async () => {
    writeFileSync(designMd, makeStage1Design());
    const result = await handlePostToolUse(editInput(designMd, repoRoot));
    expect(result?.hookSpecificOutput?.additionalContext).toMatch(/停止|stop/i);
    expect(result?.hookSpecificOutput?.additionalContext).toMatch(/feat-flow approve/);
  });
});

// ─── stage-2 (auto-advance, no gate) ─────────────────────────────────────────

describe('PostToolUse: stage-2 auto-advance', () => {
  let repoRoot: string;
  let cleanup: () => void;
  let designMd: string;

  beforeEach(() => {
    ({ repoRoot, cleanup } = createTestRepo());
    writeMarker(repoRoot, 'test-flow');
    writeState(repoRoot, { current_stage: 'stage-2' });
    mkdirSync(join(repoRoot, 'docs/feat-flows/test-flow'), { recursive: true });
    designMd = join(repoRoot, 'docs/feat-flows/test-flow/design.md');
  });
  afterEach(() => cleanup());

  it('all anchors → auto-advance to stage-3, no gate token', async () => {
    writeFileSync(designMd, [
      '## 探索摘要', '', 'Found entry points.', '',
      '## 影响范围', '', '- src/auth/login.ts', '',
      '## STAGE-2-COMPLETE', '', 'Done.',
    ].join('\n'));
    const result = await handlePostToolUse(editInput(designMd, repoRoot));
    expect(result).not.toBeNull();
    const state = readState(repoRoot);
    expect(state.current_stage).toBe('stage-3');
    expect(state.waiting_for_gate).toBe(false);
    expect(existsSync(join(repoRoot, '.feat-flow/gate-token'))).toBe(false);
  });
});

// ─── stage-4 ──────────────────────────────────────────────────────────────────

describe('PostToolUse: stage-4 plan completion', () => {
  let repoRoot: string;
  let cleanup: () => void;
  let planMd: string;

  beforeEach(() => {
    ({ repoRoot, cleanup } = createTestRepo());
    writeMarker(repoRoot, 'test-flow');
    writeState(repoRoot, { current_stage: 'stage-4' });
    mkdirSync(join(repoRoot, 'docs/feat-flows/test-flow'), { recursive: true });
    planMd = join(repoRoot, 'docs/feat-flows/test-flow/plan.md');
  });
  afterEach(() => cleanup());

  it('## Tasks (capital T) + tasks + ## STAGE-4-COMPLETE → GATE', async () => {
    writeFileSync(planMd, makePlanMd({ total: 3 }) + '\n## STAGE-4-COMPLETE\nDone.');
    const result = await handlePostToolUse(editInput(planMd, repoRoot));
    expect(result).not.toBeNull();
    const state = readState(repoRoot);
    expect(state.waiting_for_gate).toBe(true);
  });

  it('lowercase ## tasks → no trigger (case-sensitive)', async () => {
    writeFileSync(planMd, makePlanMd({ total: 2 })
      .replace('## Tasks', '## tasks') + '\n## STAGE-4-COMPLETE\nDone.');
    const result = await handlePostToolUse(editInput(planMd, repoRoot));
    expect(result).toBeNull();
  });

  it('no task entries → no trigger', async () => {
    writeFileSync(planMd, '## Tasks\n\n(none yet)\n\n## STAGE-4-COMPLETE\nDone.');
    const result = await handlePostToolUse(editInput(planMd, repoRoot));
    expect(result).toBeNull();
  });
});

// ─── stage-5 task-level gates ─────────────────────────────────────────────────

describe('PostToolUse: stage-5 task-level [GATE]', () => {
  let repoRoot: string;
  let cleanup: () => void;
  let planMd: string;

  beforeEach(() => {
    ({ repoRoot, cleanup } = createTestRepo());
    writeMarker(repoRoot, 'test-flow');
    writeState(repoRoot, { current_stage: 'stage-5' });
    mkdirSync(join(repoRoot, 'docs/feat-flows/test-flow'), { recursive: true });
    planMd = join(repoRoot, 'docs/feat-flows/test-flow/plan.md');
  });
  afterEach(() => cleanup());

  it('task with [GATE] just checked → triggers task-level gate', async () => {
    // Task 2 has [GATE] and is now checked
    writeFileSync(planMd, makePlanMd({ total: 4, completed: 2, gateOnTask: 2 }));
    const result = await handlePostToolUse(editInput(planMd, repoRoot));
    expect(result).not.toBeNull();
    const state = readState(repoRoot);
    expect(state.waiting_for_gate).toBe(true);
    expect(state.gate_type).toBe('task');
    // stage does NOT advance
    expect(state.current_stage).toBe('stage-5');
  });

  it('## GATE-REQUEST: pattern is ignored (feature removed)', async () => {
    const someFile = join(repoRoot, 'src/auth/login.ts');
    mkdirSync(join(repoRoot, 'src/auth'), { recursive: true });
    writeFileSync(someFile, [
      'export function login() {}',
      '',
      '## GATE-REQUEST: 发现 API 签名与文档不一致',
    ].join('\n'));
    // Should NOT trigger any gate — ai-request gate was removed
    const result = await handlePostToolUse(editInput(someFile, repoRoot));
    expect(result).toBeNull();
  });

  it('all tasks [x] + ## STAGE-5-COMPLETE → auto-advance to stage-6', async () => {
    writeFileSync(planMd, makePlanMd({ total: 3, completed: 3, withStageComplete: true }));
    const result = await handlePostToolUse(editInput(planMd, repoRoot));
    expect(result).not.toBeNull();
    const state = readState(repoRoot);
    expect(state.current_stage).toBe('stage-6');
    expect(state.waiting_for_gate).toBe(false);
  });

  it('unchecked tasks remain → no trigger', async () => {
    writeFileSync(planMd, makePlanMd({ total: 3, completed: 1 }));
    const result = await handlePostToolUse(editInput(planMd, repoRoot));
    expect(result).toBeNull();
  });
});

// ─── stage-6 verification files ───────────────────────────────────────────────

describe('PostToolUse: stage-6 verification', () => {
  let repoRoot: string;
  let cleanup: () => void;
  let verifyDir: string;

  beforeEach(() => {
    ({ repoRoot, cleanup } = createTestRepo());
    writeMarker(repoRoot, 'test-flow');
    writeState(repoRoot, { current_stage: 'stage-6' });
    verifyDir = join(repoRoot, 'docs/feat-flows/test-flow/verification');
    mkdirSync(verifyDir, { recursive: true });
  });
  afterEach(() => cleanup());

  it('only lint.txt → no trigger', async () => {
    writeFileSync(join(verifyDir, 'lint.txt'), 'ok');
    const result = await handlePostToolUse(editInput(join(verifyDir, 'lint.txt'), repoRoot));
    expect(result).toBeNull();
  });

  it('all three files → auto-advance to stage-7', async () => {
    writeFileSync(join(verifyDir, 'lint.txt'), 'ok');
    writeFileSync(join(verifyDir, 'typecheck.txt'), 'ok');
    writeFileSync(join(verifyDir, 'test.txt'), 'passed');
    const result = await handlePostToolUse(editInput(join(verifyDir, 'test.txt'), repoRoot));
    expect(result).not.toBeNull();
    expect(readState(repoRoot).current_stage).toBe('stage-7');
  });
});

// ─── context window monitoring ────────────────────────────────────────────────

describe('PostToolUse: context window monitoring', () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repoRoot, cleanup } = createTestRepo());
    writeMarker(repoRoot, 'test-flow');
  });
  afterEach(() => cleanup());

  it('context < 35% → no warning', async () => {
    writeState(repoRoot, {
      current_stage: 'stage-5',
      context_size: 1_000_000,
      context_warning: { warned: false, warned_at_pct: null, warned_at: null },
    });
    // Provide a mock JSONL showing 30% usage
    const mockUsage = { input_tokens: 100, cache_creation_input_tokens: 299_900, cache_read_input_tokens: 0 };
    writeTestTranscript(repoRoot, 'sess-001', mockUsage);

    const planMd = join(repoRoot, 'docs/feat-flows/test-flow/plan.md');
    mkdirSync(join(repoRoot, 'docs/feat-flows/test-flow'), { recursive: true });
    writeFileSync(planMd, 'some content');

    const result = await handlePostToolUse(editInput(planMd, repoRoot));
    // result may be null (no stage completion + no context warning) — that's correct
    expect(result?.systemMessage ?? '').not.toMatch(/Context/);
  });

  it('context >= 35% + not yet warned → warning injected', async () => {
    writeState(repoRoot, {
      current_stage: 'stage-5',
      context_size: 1_000_000,
      context_warning: { warned: false, warned_at_pct: null, warned_at: null },
    });
    // 40% usage
    const mockUsage = { input_tokens: 100, cache_creation_input_tokens: 399_900, cache_read_input_tokens: 0 };
    writeTestTranscript(repoRoot, 'sess-001', mockUsage);

    const planMd = join(repoRoot, 'docs/feat-flows/test-flow/plan.md');
    mkdirSync(join(repoRoot, 'docs/feat-flows/test-flow'), { recursive: true });
    writeFileSync(planMd, 'content');

    const result = await handlePostToolUse(editInput(planMd, repoRoot));
    expect(result?.systemMessage).toMatch(/Context|context/i);
    expect(result?.systemMessage).toMatch(/35%|40%/);
  });

  it('already warned at 37%, now at 40% (delta < 5%) → no repeat warning', async () => {
    writeState(repoRoot, {
      current_stage: 'stage-5',
      context_size: 1_000_000,
      context_warning: { warned: true, warned_at_pct: 37, warned_at: new Date().toISOString() },
    });
    const mockUsage = { input_tokens: 100, cache_creation_input_tokens: 399_900, cache_read_input_tokens: 0 };
    writeTestTranscript(repoRoot, 'sess-001', mockUsage);

    const planMd = join(repoRoot, 'docs/feat-flows/test-flow/plan.md');
    mkdirSync(join(repoRoot, 'docs/feat-flows/test-flow'), { recursive: true });
    writeFileSync(planMd, 'content');

    const result = await handlePostToolUse(editInput(planMd, repoRoot));
    // result may be null (no stage completion + delta < 5% so no re-warning)
    expect(result?.systemMessage ?? '').not.toMatch(/Context/);
  });

  it('context >= 55% → urgent warning', async () => {
    writeState(repoRoot, {
      current_stage: 'stage-5',
      context_size: 1_000_000,
      context_warning: { warned: true, warned_at_pct: 35, warned_at: new Date().toISOString() },
    });
    // 60% usage
    const mockUsage = { input_tokens: 100, cache_creation_input_tokens: 599_900, cache_read_input_tokens: 0 };
    writeTestTranscript(repoRoot, 'sess-001', mockUsage);

    const planMd = join(repoRoot, 'docs/feat-flows/test-flow/plan.md');
    mkdirSync(join(repoRoot, 'docs/feat-flows/test-flow'), { recursive: true });
    writeFileSync(planMd, 'content');

    const result = await handlePostToolUse(editInput(planMd, repoRoot));
    expect(result?.systemMessage).toMatch(/55%|60%/);
    // urgent indicator
    expect(result?.systemMessage).toMatch(/立即|urgent|🚨/i);
  });
});

// ─── test helper ──────────────────────────────────────────────────────────────

function writeTestTranscript(
  repoRoot: string,
  sessionId: string,
  usage: { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number },
) {
  const encoded = repoRoot.replace(/\//g, '-');
  const transcriptDir = join(require('os').homedir(), '.claude/projects', encoded);
  mkdirSync(transcriptDir, { recursive: true });
  const entry = JSON.stringify({
    type: 'assistant',
    message: { model: 'claude-sonnet-4-6', usage },
  });
  writeFileSync(join(transcriptDir, `${sessionId}.jsonl`), entry + '\n');
}
