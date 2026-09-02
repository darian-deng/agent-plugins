import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { handlePostTool } from '../src/lib/posttool-handler.js';
import { readActiveState, signalPath, markBasePath } from '../src/lib/state.js';
import { execSync } from 'child_process';
import { createFlowTestRepo, writeActiveState, MINIMAL_CONFIG, BLOCKING_CONFIG, GATED_CONFIG } from './fixtures/helpers.js';
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

  it('mark-base marker → engine captures base_sha_code = HEAD', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const head = execSync('git rev-parse HEAD', { cwd: repo.repoRoot, encoding: 'utf-8' }).trim();
    const input = makeInput(repo.repoRoot, 'Write', 10);
    (input.tool_input as Record<string, unknown>)['file_path'] = markBasePath(repo.repoRoot, 'test-flow');
    const out = await handlePostTool(input);
    expect(out?.additionalContext).toContain(head);
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.base_sha_code).toBe(head);
  });

  it('mark-base marker when base_sha_code already set → does not overwrite', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
      base_sha_code: 'PRESET_SHA',
    });
    const input = makeInput(repo.repoRoot, 'Write', 10);
    (input.tool_input as Record<string, unknown>)['file_path'] = markBasePath(repo.repoRoot, 'test-flow');
    const out = await handlePostTool(input);
    expect(out?.additionalContext).toMatch(/已存在/);
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.base_sha_code).toBe('PRESET_SHA');
  });

  // Context sampling deliberately runs for EVERY tool: a stage whose main session
  // "only schedules" edits its docs through Bash heredocs, so a write-tool-only
  // gate measured almost nothing (three recorded sessions did zero Edit/Write yet
  // peaked at 65–72.5% against a 60% block threshold).
  it('non-write tool → context is still sampled (no early return)', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Read', 80));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toContain('80%');
  });

  it('non-write tool below warn_at_pct → null', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    expect(await handlePostTool(makeInput(repo.repoRoot, 'Bash', 10))).toBeNull();
  });

  // The marker paths are matched on tool_input.file_path alone, and Read carries a
  // file_path too — pretool's own deny text even tells the AI to Read the signal
  // file. Sampling on every tool must therefore NOT let a read trip either marker.
  it('Read on the mark-base path does not capture base_sha_code', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const input = makeInput(repo.repoRoot, 'Read', 10);
    (input.tool_input as Record<string, unknown>)['file_path'] = markBasePath(repo.repoRoot, 'test-flow');
    expect(await handlePostTool(input)).toBeNull();
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.base_sha_code).toBeUndefined();
  });

  it('Read on the signal path does not advance the stage', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const sig = signalPath(repo.repoRoot, 'test-flow');
    const { writeFileSync, mkdirSync } = await import('fs');
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    writeFileSync(sig, 'done');
    const input = makeInput(repo.repoRoot, 'Read', 10);
    (input.tool_input as Record<string, unknown>)['file_path'] = sig;
    expect(await handlePostTool(input)).toBeNull();
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.current_stage).toBe('work');
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
    expect(out!.additionalContext).toContain('65%');
    // The brief tells the model to wrap up, not to freeze: one session read the old
    // "stop calling tools" wording as "every tool is dead", wrote its handoff into a
    // session-private scratchpad the next session could not find, and lost a
    // correctness finding that overturned an earlier ruling.
    expect(out!.additionalContext).toContain('收尾');
    expect(out!.additionalContext).not.toContain('不要再尝试任何工具调用');
    expect(out!.additionalContext).toMatch(/仍然放行|仍可写/);
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
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toContain('70%');
    // Already latched → the short nudge, not the full brief again.
    expect(out!.additionalContext).toContain('收尾窗口');
    expect(out!.additionalContext.length).toBeLessThan(200);
  });

  // Sampling on every tool means this branch runs hundreds of times per session.
  // Replaying the full brief each time would fire 18–63 times (simulated against
  // three recorded pct series), so it throttles on its own water mark.
  it('block reminder throttled until pct advances by rewarn_delta', async () => {
    const repo = makeBlockingRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
      context_blocked: true,
      context_warning: {
        warned: true, warned_at_pct: 65, warned_at: new Date().toISOString(),
        block_reminded_at_pct: 70,
      },
    });
    // BLOCKING_CONFIG's rewarn delta keeps 70 → 70 under the step.
    expect(await handlePostTool(makeInput(repo.repoRoot, 'Write', 70))).toBeNull();
  });

  it('block reminder records its own water mark on first fire', async () => {
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
    expect(state!.context_warning.block_reminded_at_pct).toBe(65);
    expect(state!.context_warning.warned_at_pct).toBe(65);
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

function makeSignalInput(repoRoot: string, toolName: string, filePath: string, content: string): PostToolInput {
  return {
    hook_event_name: 'PostToolUse',
    session_id: 'sess-1',
    cwd: repoRoot,
    tool_name: toolName,
    tool_input: { file_path: filePath, content },
    tool_response: null,
    context_size_pct: 10,
  } as PostToolInput & { context_size_pct: number };
}

describe('handlePostTool — signal detection', () => {
  it("signal='done' via non-gate stage → stage advances, additionalContext contains next stage prompt", async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const sig = signalPath(repo.repoRoot, 'test-flow');
    const { writeFileSync, mkdirSync } = await import('fs');
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    writeFileSync(sig, 'done');
    const out = await handlePostTool(makeSignalInput(repo.repoRoot, 'Write', sig, 'done'));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toContain('review');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('review');
  });

  it("signal='done' via gate stage → additionalContext contains gate pending message", async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'review',
      base_sha: 'abc',
    });
    const sig = signalPath(repo.repoRoot, 'test-flow');
    const { writeFileSync, mkdirSync } = await import('fs');
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    writeFileSync(sig, 'done');
    const out = await handlePostTool(makeSignalInput(repo.repoRoot, 'Write', sig, 'done'));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toMatch(/approve|gate|confirm/i);
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('review');
  });

  it("signal='done' at terminal no-gate stage → active.json deleted", async () => {
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
      requirement: 'test',
      current_stage: 'review',
      base_sha: 'abc',
    });
    const sig = signalPath(repo.repoRoot, 'test-flow');
    const { writeFileSync, mkdirSync } = await import('fs');
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    writeFileSync(sig, 'done');
    const out = await handlePostTool(makeSignalInput(repo.repoRoot, 'Write', sig, 'done'));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toMatch(/complete|完成/i);
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).toBeNull();
  });

  it('non-signal write → no gate/advance logic, returns context warning or null', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const out = await handlePostTool(makeSignalInput(repo.repoRoot, 'Write', '/tmp/some-file.ts', 'content'));
    // Should be null or context warning — NOT gate/advance message
    if (out !== null) {
      expect(out.additionalContext).not.toMatch(/ai-flow.*stage.*complet/i);
    }
    // Stage unchanged
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('work');
  });

  // ── New protocol: AI writes 'done' ──────────────────────────────────────

  it("signal='done' + non-gate stage → advances stage, signal cleared", async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow', requirement: 'test',
      current_stage: 'work', base_sha: 'abc',
    });
    const sig = signalPath(repo.repoRoot, 'test-flow');
    const { writeFileSync, mkdirSync } = await import('fs');
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    writeFileSync(sig, 'done');
    const out = await handlePostTool(makeSignalInput(repo.repoRoot, 'Write', sig, 'done'));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toContain('review');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('review');
    // Signal cleared after advance
    expect(existsSync(sig)).toBe(false);
  });

  it("signal='done' + gate stage → signal rewritten to next-stage-id, gate pending returned", async () => {
    // GATED_CONFIG: work has gate=true, next is 'review'
    const repo = createFlowTestRepo('test-flow', GATED_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow', requirement: 'test',
      current_stage: 'work', base_sha: 'abc',
    });
    const sig = signalPath(repo.repoRoot, 'test-flow');
    const { writeFileSync, mkdirSync } = await import('fs');
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    writeFileSync(sig, 'done');
    const out = await handlePostTool(makeSignalInput(repo.repoRoot, 'Write', sig, 'done'));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toMatch(/approve|gate|confirm/i);
    // Non-terminal gate → advance wording, NOT end-flow wording
    expect(out!.additionalContext).toContain('进入下一阶段');
    expect(out!.additionalContext).not.toContain('结束流程');
    // Signal rewritten to next stage id (not 'done')
    expect(readFileSync(sig, 'utf-8').trim()).toBe('review');
    // Stage NOT advanced
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('work');
  });

  it("signal='done' + terminal gate stage → signal rewritten to 'flow-complete', gate pending returned", async () => {
    // MINIMAL_CONFIG: review is terminal with gate=true
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow', requirement: 'test',
      current_stage: 'review', base_sha: 'abc',
    });
    const sig = signalPath(repo.repoRoot, 'test-flow');
    const { writeFileSync, mkdirSync } = await import('fs');
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    writeFileSync(sig, 'done');
    const out = await handlePostTool(makeSignalInput(repo.repoRoot, 'Write', sig, 'done'));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toMatch(/approve|gate|confirm/i);
    // Terminal gate → end-flow wording, NOT advance wording
    expect(out!.additionalContext).toContain('确认并结束流程');
    expect(out!.additionalContext).not.toContain('进入下一阶段');
    // Signal rewritten to 'flow-complete'
    expect(readFileSync(sig, 'utf-8').trim()).toBe('flow-complete');
    // Stage NOT advanced
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('review');
  });

  it("signal='done' + terminal no-gate stage → flow completes, active.json deleted", async () => {
    const noGateTerminalConfig = {
      schema_version: '1.0' as const,
      name: 'test-flow',
      stages: [
        { id: 'work', prompt: 'stages/work.md', write_scope: 'unrestricted' as const, completion: {} },
        { id: 'review', prompt: 'stages/review.md', write_scope: 'unrestricted' as const, completion: {} },
      ],
    };
    const repo = createFlowTestRepo('test-flow', noGateTerminalConfig);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow', requirement: 'test',
      current_stage: 'review', base_sha: 'abc',
    });
    const sig = signalPath(repo.repoRoot, 'test-flow');
    const { writeFileSync, mkdirSync } = await import('fs');
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    writeFileSync(sig, 'done');
    const out = await handlePostTool(makeSignalInput(repo.repoRoot, 'Write', sig, 'done'));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toMatch(/complete|完成/i);
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).toBeNull();
  });
});

describe('handlePostTool — concurrent state writes', () => {
  // PostToolUse fires per write tool call and hooks run in parallel, so the
  // mark-base capture and a context-warning write can be in flight at the same
  // moment, each holding the ActiveState it read at its own entry. A whole-document
  // write-back makes the later one erase the other's field; base_sha_code is the
  // costly loss, since the stage completion scripts that diff against it are
  // fail-closed and reject the gate when it is missing.
  it('mark-base capture racing a context warning → both fields survive', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const head = execSync('git rev-parse HEAD', { cwd: repo.repoRoot, encoding: 'utf-8' }).trim();

    const markInput = makeInput(repo.repoRoot, 'Write', 10);
    (markInput.tool_input as Record<string, unknown>)['file_path'] = markBasePath(repo.repoRoot, 'test-flow');
    const warnInput = makeInput(repo.repoRoot, 'Write', 80);

    await Promise.all([handlePostTool(markInput), handlePostTool(warnInput)]);

    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.base_sha_code).toBe(head);
    expect(state!.context_warning.warned).toBe(true);
    expect(state!.context_warning.warned_at_pct).toBe(80);
  });

  it('two mark-base captures racing → first-writer-wins, one SHA only', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const head = execSync('git rev-parse HEAD', { cwd: repo.repoRoot, encoding: 'utf-8' }).trim();
    const mark = () => {
      const i = makeInput(repo.repoRoot, 'Write', 10);
      (i.tool_input as Record<string, unknown>)['file_path'] = markBasePath(repo.repoRoot, 'test-flow');
      return handlePostTool(i);
    };
    const outs = await Promise.all([mark(), mark()]);
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.base_sha_code).toBe(head);
    expect(outs.filter((o) => /已存在/.test(o?.additionalContext ?? ''))).toHaveLength(1);
  });

  it('context warning does not resurrect a flow that completed meanwhile', async () => {
    const repo = makeRepo();
    // No active.json: stands in for a flow completed or aborted while a hook from
    // the previous stage was still in flight.
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 80));
    expect(out).toBeNull();
    expect(existsSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'active.json'))).toBe(false);
  });
});

describe('handlePostTool — subagent context accounting', () => {
  function makeSubagentInput(repoRoot: string, contextPct: number, agentId = 'agent-abc'): PostToolInput {
    return { ...makeInput(repoRoot, 'Write', contextPct), agent_id: agentId, agent_type: 'reviewer' };
  }

  function seed(repoRoot: string): void {
    writeActiveState(repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
  }

  it('agent_id present → no warning injected and no state write', async () => {
    const repo = makeRepo();
    seed(repo.repoRoot);
    const before = readFileSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'active.json'), 'utf-8');
    const out = await handlePostTool(makeSubagentInput(repo.repoRoot, 80));
    expect(out).toBeNull();
    const after = readFileSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'active.json'), 'utf-8');
    expect(after).toBe(before);
  });

  it('agent_id absent → warning injected (unchanged main-session behavior)', async () => {
    const repo = makeRepo();
    seed(repo.repoRoot);
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 80));
    expect(out!.additionalContext).toMatch(/Context 当前 80%/);
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.context_warning.warned).toBe(true);
  });

  it('agent_id present + past block threshold → context_blocked NOT latched', async () => {
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    seed(repo.repoRoot);
    const out = await handlePostTool(makeSubagentInput(repo.repoRoot, 95));
    expect(out).toBeNull();
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.context_blocked).toBe(false);
  });

  it('agent_id absent + past block threshold → context_blocked latched (unchanged)', async () => {
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    seed(repo.repoRoot);
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 95));
    expect(out!.additionalContext).toMatch(/block 阈值/);
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.context_blocked).toBe(true);
  });

  it('agent_id present → mark-base capture still runs (only accounting is skipped)', async () => {
    const repo = makeRepo();
    seed(repo.repoRoot);
    const head = execSync('git rev-parse HEAD', { cwd: repo.repoRoot, encoding: 'utf-8' }).trim();
    const input = makeSubagentInput(repo.repoRoot, 10);
    (input.tool_input as Record<string, unknown>)['file_path'] = markBasePath(repo.repoRoot, 'test-flow');
    await handlePostTool(input);
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.base_sha_code).toBe(head);
  });
});
