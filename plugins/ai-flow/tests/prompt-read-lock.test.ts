import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import { writeFileSync, unlinkSync, realpathSync } from 'fs';
import { handlePreTool } from '../src/lib/pretool-handler.js';
import { handlePostTool } from '../src/lib/posttool-handler.js';
import { advanceStage } from '../src/lib/advance-stage.js';
import { readActiveState, PROMPT_READ_MAX_DENIES, type PromptReadLock } from '../src/lib/state.js';
import { injectStagePrompt } from '../src/lib/stage-injection.js';
import { READ_SAFE_CHARS, READ_MAX_LINE_CHARS } from '../src/lib/prompt-render.js';
import { createFlowTestRepo, writeActiveState, MINIMAL_CONFIG } from './fixtures/helpers.js';
import type { PreToolInput, PostToolInput } from '../src/lib/types.js';

/**
 * Over the inline budget a stage prompt is handed over as a file. These pin the lock that
 * makes that hand-over reliable: the owning main session cannot do anything else until it
 * has Read the file whole, and the lock heals itself instead of wedging the flow.
 */

let cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups) c(); cleanups = []; });

const OWNER = 'sess-1';

function setup(lock?: Partial<PromptReadLock>) {
  const repo = createFlowTestRepo('test-flow', MINIMAL_CONFIG);
  cleanups.push(repo.cleanup);
  const promptFile = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'current-prompt.md');
  writeActiveState(repo.repoRoot, 'test-flow', {
    flow_id: 'test-flow-abc', flow_name: 'test-flow', requirement: 'test',
    current_stage: 'work', base_sha: 'abc', last_session_id: OWNER,
    prompt_read_pending: { path: promptFile, stage: 'work', session_id: OWNER, denies: 0, ...lock },
  });
  writeFileSync(promptFile, '<!-- ai-flow: stage=work -->\n# work\nline\n');
  return { repoRoot: repo.repoRoot, promptFile };
}

function pre(repoRoot: string, tool: string, input: Record<string, unknown>, extra: Partial<PreToolInput> = {}): PreToolInput {
  return { hook_event_name: 'PreToolUse', session_id: OWNER, cwd: repoRoot, tool_name: tool, tool_input: input, ...extra };
}

function post(repoRoot: string, filePath: string, file: Record<string, unknown>, extra: Partial<PostToolInput> = {}): PostToolInput {
  return {
    hook_event_name: 'PostToolUse', session_id: OWNER, cwd: repoRoot, tool_name: 'Read',
    tool_input: { file_path: filePath }, tool_response: { type: 'text', file }, ...extra,
  };
}

const lockOf = async (repoRoot: string) => (await readActiveState(repoRoot, 'test-flow'))?.prompt_read_pending ?? null;
const allowed = (out: { permissionDecision?: string } | null) => (out?.permissionDecision ?? 'allow') === 'allow';

describe('提示词读锁：PreToolUse', () => {
  it('所属主 session 在读完之前：Bash / Write / 读别的文件一律拒，拒因点名要读的路径', async () => {
    const { repoRoot, promptFile } = setup();
    for (const [tool, input] of [
      ['Bash', { command: 'ls' }],
      ['Write', { file_path: join(repoRoot, 'x.txt'), content: 'x' }],
      ['Read', { file_path: join(repoRoot, 'README.md') }],
    ] as const) {
      const out = await handlePreTool(pre(repoRoot, tool, input));
      expect(out?.permissionDecision, tool).toBe('deny');
      expect(out?.permissionDecisionReason).toContain(promptFile);
    }
  });

  it('Bash cat / head 读它也拒（实测出现过 `cat … | head -50` 只读一半）', async () => {
    const { repoRoot, promptFile } = setup();
    const out = await handlePreTool(pre(repoRoot, 'Bash', { command: `cat ${promptFile} | head -50` }));
    expect(out?.permissionDecision).toBe('deny');
  });

  it('Read 那份文件放行；另一种路径写法（macOS /var ↔ /private/var）同样认得', async () => {
    const { repoRoot, promptFile } = setup();
    expect(allowed(await handlePreTool(pre(repoRoot, 'Read', { file_path: promptFile })))).toBe(true);
    expect(allowed(await handlePreTool(pre(repoRoot, 'Read', { file_path: realpathSync(promptFile) })))).toBe(true);
  });

  it('子代理不受锁影响', async () => {
    const { repoRoot } = setup();
    expect(allowed(await handlePreTool(pre(repoRoot, 'Bash', { command: 'ls' }, { agent_id: 'sub-1' })))).toBe(true);
  });

  it('同一检出里的另一个 session 不受锁影响', async () => {
    const { repoRoot } = setup();
    expect(allowed(await handlePreTool(pre(repoRoot, 'Bash', { command: 'ls' }, { session_id: 'sess-other' })))).toBe(true);
  });

  it('自愈：锁属于别的 stage → 丢锁放行', async () => {
    const { repoRoot } = setup({ stage: 'review' });
    expect(allowed(await handlePreTool(pre(repoRoot, 'Bash', { command: 'ls' })))).toBe(true);
    expect(await lockOf(repoRoot)).toBeNull();
  });

  it('自愈：文件已不存在 → 丢锁放行', async () => {
    const { repoRoot, promptFile } = setup();
    unlinkSync(promptFile);
    expect(allowed(await handlePreTool(pre(repoRoot, 'Bash', { command: 'ls' })))).toBe(true);
    expect(await lockOf(repoRoot)).toBeNull();
  });

  it('一批并行调用只算一轮拒绝：不会在模型还没看到拒因时就把额度耗光', async () => {
    const { repoRoot } = setup();
    for (const cmd of ['git status', 'ls', 'pwd']) {
      expect((await handlePreTool(pre(repoRoot, 'Bash', { command: cmd })))?.permissionDecision).toBe('deny');
    }
    expect((await lockOf(repoRoot))?.denies).toBe(1);
  });

  it('隔开的几轮分别计数', async () => {
    const { repoRoot } = setup({ denies: 1, last_deny_at: Date.now() - 60_000 });
    await handlePreTool(pre(repoRoot, 'Bash', { command: 'ls' }));
    expect((await lockOf(repoRoot))?.denies).toBe(2);
  });

  it(`自愈：拒满 ${PROMPT_READ_MAX_DENIES} 轮后丢锁，不把 flow 卡死`, async () => {
    const { repoRoot } = setup({ denies: PROMPT_READ_MAX_DENIES, last_deny_at: Date.now() - 60_000 });
    expect(allowed(await handlePreTool(pre(repoRoot, 'Bash', { command: 'ls' })))).toBe(true);
    expect(await lockOf(repoRoot)).toBeNull();
  });
});

describe('提示词读锁：PostToolUse 解锁', () => {
  it('整篇读完（startLine 1、numLines === totalLines）→ 解锁', async () => {
    const { repoRoot, promptFile } = setup();
    await handlePostTool(post(repoRoot, promptFile, { filePath: promptFile, startLine: 1, numLines: 3, totalLines: 3 }));
    expect(await lockOf(repoRoot)).toBeNull();
  });

  it('只读了一部分（带 limit，或被 token 上限截断）→ 不解锁', async () => {
    const { repoRoot, promptFile } = setup();
    await handlePostTool(post(repoRoot, promptFile, { filePath: promptFile, startLine: 1, numLines: 2, totalLines: 3 }));
    await handlePostTool(post(repoRoot, promptFile, { filePath: promptFile, startLine: 2, numLines: 2, totalLines: 3 }));
    await handlePostTool(post(repoRoot, promptFile, { filePath: promptFile, startLine: 1, numLines: 769, totalLines: 2580, truncatedByTokenCap: true }));
    expect(await lockOf(repoRoot)).not.toBeNull();
  });

  it('读的是别的文件、或是子代理读的 → 不解锁', async () => {
    const { repoRoot, promptFile } = setup();
    const other = join(repoRoot, 'README.md');
    await handlePostTool(post(repoRoot, other, { filePath: other, startLine: 1, numLines: 1, totalLines: 1 }));
    await handlePostTool(post(repoRoot, promptFile, { filePath: promptFile, startLine: 1, numLines: 3, totalLines: 3 }, { agent_id: 'sub-1' }));
    expect(await lockOf(repoRoot)).not.toBeNull();
  });
});

describe('提示词读锁：挂锁与清锁', () => {
  it('推进进一个超预算的 stage → 挂上锁，指向落盘副本，归属推进它的 session', async () => {
    const repo = createFlowTestRepo('test-flow', MINIMAL_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow', requirement: 'test',
      current_stage: 'work', base_sha: 'abc', last_session_id: OWNER,
    });
    // 超内联、但一次 Read 读得完（行数远小于 2000）。
    writeFileSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'stages', 'review.md'), '# review\n' + ('规则。'.repeat(200) + '\n').repeat(20));
    const out = await advanceStage(repo.repoRoot, 'test-flow', OWNER);
    const lock = await lockOf(repo.repoRoot);
    expect(lock?.stage).toBe('review');
    expect(lock?.session_id).toBe(OWNER);
    expect(out.additionalContext).toContain(lock!.path);
  });

  it('一次 Read 读不完的页面：给指路、叫它分段读，但不上锁（那把锁永远解不开）', async () => {
    const repo = createFlowTestRepo('test-flow', MINIMAL_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow', requirement: 'test',
      current_stage: 'work', base_sha: 'abc', last_session_id: OWNER,
    });
    for (const body of ['规则。'.repeat(READ_SAFE_CHARS), 'x'.repeat(10_050) + '\n' + '长'.repeat(READ_MAX_LINE_CHARS + 10)]) {
      const text = await injectStagePrompt({
        repoRoot: repo.repoRoot, flowName: 'test-flow', stageId: 'work', sessionId: OWNER,
        rendered: body, promptPath: join(repo.repoRoot, 'p.md'), overhead: 0,
      });
      expect(text).toContain('分段读');
      expect(await lockOf(repo.repoRoot)).toBeNull();
    }
  });

  it('行数卡在临界值：量的是落盘文件（带头），多出来的头让它读不完 → 不上锁', async () => {
    const repo = createFlowTestRepo('test-flow', MINIMAL_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow', requirement: 'test',
      current_stage: 'work', base_sha: 'abc', last_session_id: OWNER,
    });
    const body = Array.from({ length: 1998 }, () => '规则规则规则').join('\n');   // 1998 行、约 14K 字符：超内联，正文本身读得完
    await injectStagePrompt({
      repoRoot: repo.repoRoot, flowName: 'test-flow', stageId: 'work', sessionId: OWNER,
      rendered: body, promptPath: join(repo.repoRoot, 'p.md'), overhead: 0,
    });
    expect(await lockOf(repo.repoRoot)).toBeNull();
  });

  it('同一 stage 再次注入时改走内联（例如压缩后 SessionStart 包裹更短）→ 旧锁被清掉', async () => {
    const { repoRoot } = setup();
    await injectStagePrompt({
      repoRoot, flowName: 'test-flow', stageId: 'work', sessionId: OWNER,
      rendered: '# work\nshort', promptPath: join(repoRoot, 'p.md'), overhead: 0,
    });
    expect(await lockOf(repoRoot)).toBeNull();
  });

  it('推进进一个能内联的 stage → 旧锁被无条件清掉', async () => {
    const { repoRoot } = setup();
    await advanceStage(repoRoot, 'test-flow', OWNER);
    expect(await lockOf(repoRoot)).toBeNull();
  });
});
