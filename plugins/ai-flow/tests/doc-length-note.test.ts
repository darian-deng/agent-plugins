import { describe, it, expect, afterEach } from 'vitest';
import { handleStart } from '../src/lib/commands/start.js';
import { advanceStage } from '../src/lib/advance-stage.js';
import { handleSessionStart } from '../src/lib/session-handler.js';
import { renderPrompt, writtenDocLengthNote } from '../src/lib/prompt-render.js';
import {
  createFlowTestRepo,
  writeActiveState,
  writeSignal,
  MINIMAL_CONFIG,
  GATED_CONFIG,
  SCRIPTED_CONFIG,
} from './fixtures/helpers.js';
import type { SessionStartInput } from '../src/lib/types.js';

// The written-document length note rides on renderPrompt, so it reaches EVERY
// stage of every flow. That unconditional reach is the whole point and is what
// separates it from the Gate note (gated stages only) — hence the assertions
// below deliberately cover gated and non-gated stages alike.
const LEN_MARKER = '写盘文档长度';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeInput(repoRoot: string, sessionId: string, opts?: Partial<SessionStartInput>): SessionStartInput {
  return { hook_event_name: 'SessionStart', session_id: sessionId, cwd: repoRoot, ...opts };
}

describe('writtenDocLengthNote', () => {
  it('stays within the 4-line budget it pays on every injection', () => {
    const lines = writtenDocLengthNote().split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeLessThanOrEqual(4);
  });

  it('scopes itself to on-disk documents, not artifacts in general', () => {
    const note = writtenDocLengthNote();
    expect(note).toContain('写入磁盘');
    expect(note).toContain('不约束代码');
  });

  it('carries the exhaustiveness carve-out so it cannot override hard enumeration rules', () => {
    const note = writtenDocLengthNote();
    expect(note).toContain('穷举');
    expect(note).toContain('机器门');
  });
});

describe('renderPrompt appends the note', () => {
  it('appends it to a prompt with no placeholders', () => {
    const out = renderPrompt('# Stage\n\nDo the work.\n', '/repo', 'f');
    expect(out).toContain('Do the work.');
    expect(out).toContain(LEN_MARKER);
  });

  it('still substitutes placeholders', () => {
    const out = renderPrompt('root={{project_root}} flow={{flow_root}}', '/repo', 'f');
    expect(out).toContain('root=/repo');
    expect(out).toContain('/repo/.ai-flow/f');
    expect(out).toContain(LEN_MARKER);
  });
});

describe('doc length note injection points', () => {
  it('start: gated first stage gets the note', async () => {
    const repo = createFlowTestRepo('gated-flow', GATED_CONFIG);
    cleanups.push(repo.cleanup);
    const out = await handleStart(repo.repoRoot, 'gated-flow', 'do X', 'sess-1', 0);
    if (out.action !== 'allow') throw new Error(`expected allow, got ${out.action}`);
    expect(out.additionalContext).toContain(LEN_MARKER);
  });

  it('start: NON-gated first stage also gets the note (unlike the gate note)', async () => {
    const repo = createFlowTestRepo('test-flow', MINIMAL_CONFIG);
    cleanups.push(repo.cleanup);
    const out = await handleStart(repo.repoRoot, 'test-flow', 'do X', 'sess-1', 0);
    if (out.action !== 'allow') throw new Error(`expected allow, got ${out.action}`);
    expect(out.additionalContext).toContain(LEN_MARKER);
    expect(out.additionalContext).not.toContain('Gate 协议');
  });

  it('advance: entering a gated stage gets the note', async () => {
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
    expect(result.additionalContext).toContain(LEN_MARKER);
  });

  it('advance: entering a NON-gated stage also gets the note', async () => {
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
    expect(result.additionalContext).toContain(LEN_MARKER);
    expect(result.additionalContext).not.toContain('Gate 协议');
  });

  /**
   * gate-pending 分支不注入 stage 提示词正文，只给出它的路径让模型自己 Read。
   * 磁盘上的 `stages/*.md` **不含**这段长度纪律——`renderPrompt()` 只在注入路径上追加它。
   * 所以这条分支必须自己把它拼上，否则「去 Read 那个文件」这条指路把纪律丢在了半路，
   * 而 gate 上改文档正是它适用的时刻。这两条断言之外没有任何用例覆盖这条分支的内容：
   * 删掉那次拼接，其余 570+ 用例照样全绿。
   */
  it('gate-pending recovery carries the note AND points at the stage prompt', async () => {
    const repo = createFlowTestRepo('gated-flow', GATED_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'gated-flow', {
      flow_id: 'gated-flow-abc',
      flow_name: 'gated-flow',
      requirement: 'r',
      current_stage: 'review',
      base_sha: 'abc',
    });
    // review 是终端 stage，signal 'flow-complete' + gate → gate pending
    writeSignal(repo.repoRoot, 'gated-flow', 'flow-complete');
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-gp'));
    expect(out!.additionalContext).toContain(LEN_MARKER);
    // 指路本身也没有别的用例盯着：路径丢了，这条分支就退回成「只说等 approve」
    expect(out!.additionalContext).toContain('stages/review.md');
  });

  it('session recovery re-injects the note', async () => {
    const repo = createFlowTestRepo('test-flow', MINIMAL_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'r',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-new'));
    expect(out!.additionalContext).toContain(LEN_MARKER);
  });
});
