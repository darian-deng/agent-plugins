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

  it('non-write tool → null', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Read', 80));
    expect(out).toBeNull();
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
    expect(out!.additionalContext).toContain('write 工具将被自动拒绝');
    expect(out!.additionalContext).toContain('65%');
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
    expect(out!.additionalContext).toContain('write 工具将被自动拒绝');
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
