import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { handleStart } from '../src/lib/commands/start.js';
import { advanceStage } from '../src/lib/advance-stage.js';
import { handleSessionStart } from '../src/lib/session-handler.js';
import { renderPrompt, writtenDocLengthNote } from '../src/lib/prompt-render.js';
import { renderedPromptPath } from '../src/lib/state.js';
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
   * gate-pending 分支不注入 stage 提示词正文，只给出一条「去 Read 这个文件」。
   *
   * 它必须指向引擎落盘的**渲染副本**，不是 `stages/<id>.md` 模板——模板里的
   * `{{flow_root}}` / `{{project_root}}` 还是字面量（替换只发生在注入路径的
   * renderPrompt 里），而把字面占位符抄进 Write 是静默失败：建出一个字面名的目录、
   * 文件落在那里等于没写，且不报错。模板也不含引擎追加的长度纪律。
   *
   * 这三条断言分别钉住：指向副本、副本里占位符已展开、长度纪律在副本里。
   */
  it('gate-pending 指向渲染副本，且副本里占位符已展开、带长度纪律', async () => {
    const repo = createFlowTestRepo('gated-flow', GATED_CONFIG);
    cleanups.push(repo.cleanup);
    // 模板里放一个占位符，验证模型读到的那份确实已展开
    writeFileSync(
      join(repo.repoRoot, '.ai-flow', 'gated-flow', 'stages', 'review.md'),
      '# Review\n\nsignal 写到 {{flow_root}}/state/signal，产物在 {{project_root}}/docs/。\n'
    );
    writeActiveState(repo.repoRoot, 'gated-flow', {
      flow_id: 'gated-flow-abc',
      flow_name: 'gated-flow',
      requirement: 'r',
      current_stage: 'review',
      base_sha: 'abc',
    });
    writeSignal(repo.repoRoot, 'gated-flow', 'flow-complete'); // review 是终端 stage → gate pending
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-gp'));
    const ctx = out!.additionalContext!;

    // 1) 指向落盘的渲染副本，而不是模板
    const readyPath = renderedPromptPath(repo.repoRoot, 'gated-flow');
    expect(ctx).toContain(readyPath);
    expect(ctx).not.toContain('stages/review.md');

    // 2) 副本里占位符已展开——这是这条路径存在的全部意义
    const onDisk = readFileSync(readyPath, 'utf-8');
    expect(onDisk).not.toContain('{{flow_root}}');
    expect(onDisk).not.toContain('{{project_root}}');
    expect(onDisk).toContain(join(repo.repoRoot, '.ai-flow', 'gated-flow'));

    // 3) 长度纪律随副本一起到手（注入里就不必再拼一份）
    expect(onDisk).toContain(LEN_MARKER);
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
