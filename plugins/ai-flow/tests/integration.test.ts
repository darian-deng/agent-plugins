/**
 * Cross-hook integration tests.
 *
 * Pattern: PreToolUse validates → Claude Code writes file → PostToolUse/SessionStart acts.
 * We simulate the "Claude Code writes file" step manually with writeFileSync between hooks.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import { writeFileSync, existsSync } from 'fs';
import { handlePreTool } from '../src/lib/pretool-handler.js';
import { handlePostTool } from '../src/lib/posttool-handler.js';
import { handleSessionStart } from '../src/lib/session-handler.js';
import { readActiveState, readSignal, signalPath } from '../src/lib/state.js';
import {
  createFlowTestRepo,
  writeActiveState,
  writeSignal,
  MINIMAL_CONFIG,
  GATED_CONFIG,
} from './fixtures/helpers.js';
import type { PreToolInput, PostToolInput, SessionStartInput } from '../src/lib/types.js';

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeRepo(config = MINIMAL_CONFIG) {
  const repo = createFlowTestRepo('test-flow', config);
  cleanups.push(repo.cleanup);
  return repo;
}

function preTool(repoRoot: string, filePath: string, content: string): PreToolInput {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'sess-1',
    cwd: repoRoot,
    tool_name: 'Write',
    tool_input: { file_path: filePath, content },
  };
}

function postTool(repoRoot: string, filePath: string, content: string): PostToolInput & { context_size_pct: number } {
  return {
    hook_event_name: 'PostToolUse',
    session_id: 'sess-1',
    cwd: repoRoot,
    tool_name: 'Write',
    tool_input: { file_path: filePath, content },
    tool_response: null,
    context_size_pct: 10,
  } as PostToolInput & { context_size_pct: number };
}

function sessionInput(repoRoot: string): SessionStartInput {
  return { hook_event_name: 'SessionStart', session_id: 'sess-new', cwd: repoRoot };
}

// ─── Scenario 1: none-completion full path ───────────────────────────────────

describe('Integration: none stage — pretool → file write → posttool → stage advances', () => {
  it('current_stage advances from work to review after signal cycle', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow',
      requirement: 'test', current_stage: 'work', base_sha: 'abc',
    });
    const sig = signalPath(repo.repoRoot, 'test-flow');

    // PreToolUse: validate signal write is allowed
    const pre = await handlePreTool(preTool(repo.repoRoot, sig, 'done'));
    expect(pre?.permissionDecision).toBe('allow');

    // Simulate Claude Code writing 'done'
    writeFileSync(sig, 'done');

    // PostToolUse: detect 'done' → advance stage
    const post = await handlePostTool(postTool(repo.repoRoot, sig, 'done'));
    expect(post?.additionalContext).toMatch(/review|Stage/i);

    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state?.current_stage).toBe('review');
  });
});

// ─── Scenario 2: gate stage — signal allowed, advance blocked until approve ──

describe('Integration: gate stage — pretool allows, posttool holds for approve', () => {
  it('signal written, posttool returns gate-pending message, current_stage unchanged', async () => {
    const repo = makeRepo();
    // review stage has gate: true in MINIMAL_CONFIG
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow',
      requirement: 'test', current_stage: 'review', base_sha: 'abc',
    });
    const sig = signalPath(repo.repoRoot, 'test-flow');

    // PreToolUse: gate stage returns allow
    const pre = await handlePreTool(preTool(repo.repoRoot, sig, 'done'));
    expect(pre?.permissionDecision).toBe('allow');
    expect(pre?.systemMessage).toBeUndefined();

    // Simulate file write
    writeFileSync(sig, 'done');

    // PostToolUse: detects 'done' + gate → rewrites signal, gate-pending, no stage advance
    const post = await handlePostTool(postTool(repo.repoRoot, sig, 'done'));
    expect(post?.additionalContext).toMatch(/approve|等待|gate/i);

    // active.json still exists, current_stage unchanged — gate is pending
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state?.current_stage).toBe('review');
  });
});

// ─── Scenario 3: terminal stage — flow-complete cleans up everything ──────────

describe('Integration: terminal stage — flow-complete removes active.json and signal', () => {
  it('after flow-complete cycle, active.json and signal are both deleted', async () => {
    // Create a flow where the current stage is the last non-gate stage
    const terminalConfig = {
      ...MINIMAL_CONFIG,
      stages: [
        { id: 'work', prompt: 'stages/work.md', write_scope: 'unrestricted' as const, completion: {} },
        { id: 'final', prompt: 'stages/review.md', write_scope: 'unrestricted' as const, completion: {} },
      ],
    };
    const repo = makeRepo(terminalConfig);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow',
      requirement: 'test', current_stage: 'final', base_sha: 'abc',
    });
    const sig = signalPath(repo.repoRoot, 'test-flow');

    const pre = await handlePreTool(preTool(repo.repoRoot, sig, 'done'));
    expect(pre?.permissionDecision).toBe('allow');

    writeFileSync(sig, 'done');

    const post = await handlePostTool(postTool(repo.repoRoot, sig, 'done'));
    expect(post?.additionalContext).toMatch(/完成|complete|done/i);

    // Both state files cleaned up
    expect(await readActiveState(repo.repoRoot, 'test-flow')).toBeNull();
    expect(readSignal(repo.repoRoot, 'test-flow')).toBeNull();
  });
});

// ─── Scenario 4: session recovery — gate pending ─────────────────────────────

describe('Integration: session recovery with gate pending (S1 + gate)', () => {
  it('SessionStart injects approve reminder when signal matches nextStage and gate is true', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow',
      requirement: 'test', current_stage: 'review', base_sha: 'abc',
    });
    // review is terminal in MINIMAL_CONFIG (no nextStage), completion.gate = true
    // flow-complete signal → S1 + gate
    writeSignal(repo.repoRoot, 'test-flow', 'flow-complete');

    const out = await handleSessionStart(sessionInput(repo.repoRoot));
    expect(out?.additionalContext).toMatch(/approve|等待|gate/i);

    // current_stage must NOT have changed — gate blocks advancement
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state?.current_stage).toBe('review');
  });
});

// ─── Scenario 5: session recovery — self-heal for none stage ─────────────────

describe('Integration: session recovery self-heal (S1 + none completion)', () => {
  it('SessionStart advances stage when signal matches nextStage and no gate configured', async () => {
    const repo = makeRepo();
    // work stage has completion: {} (none) in MINIMAL_CONFIG → self-heal should advance
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow',
      requirement: 'test', current_stage: 'work', base_sha: 'abc',
    });
    // AI wrote 'done' but PostToolUse never ran (crash scenario)
    writeSignal(repo.repoRoot, 'test-flow', 'done');

    const out = await handleSessionStart(sessionInput(repo.repoRoot));
    // Self-heal: advance to review and inject its prompt
    expect(out?.additionalContext).toMatch(/review|Stage/i);

    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state?.current_stage).toBe('review');
  });
});
