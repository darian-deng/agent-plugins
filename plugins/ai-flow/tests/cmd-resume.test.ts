import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { handleResume } from '../src/lib/commands/resume.js';
import { handleAbort } from '../src/lib/commands/abort.js';
import { readActiveState } from '../src/lib/state.js';
import { createFlowTestRepo, writeActiveState, MINIMAL_CONFIG } from './fixtures/helpers.js';

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

function createAbortBranch(
  repoRoot: string,
  flowName: string,
  branchName: string,
  snapshot: Record<string, unknown>
): void {
  const flowId = (snapshot['flow_id'] as string) ?? 'test-flow-abc';
  execSync(`git checkout -b "${branchName}"`, { cwd: repoRoot });
  const snapshotDir = join(repoRoot, 'docs', flowName, flowId);
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(join(snapshotDir, 'state-snapshot.json'), JSON.stringify(snapshot));
  execSync('git add -A', { cwd: repoRoot });
  execSync(`git commit -m "abort snapshot"`, { cwd: repoRoot });
  execSync('git checkout -', { cwd: repoRoot });
}

describe('handleResume', () => {
  it('no branch name → error with usage hint', async () => {
    const repo = makeRepo();
    const result = await handleResume(repo.repoRoot, 'test-flow', 'test-sess', '');
    expect(result.action).toBe('deny');
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/usage|branch/i);
  });

  /**
   * 已有 active flow 时的拒绝文案。
   *
   * 这条分支最常见的到达方式是：开发者刚 `/clear`，以为要敲 resume 才能回来——其实
   * SessionStart 已经自动恢复了，flow 还 active，所以才走到这里。而这条消息里唯一的
   * 出路指向 `abort`，那是个会跑 `git add -A` 并把快照提交到新分支的破坏性命令。
   * 所以文案必须同时说清「你不用做任何事」和「别去 abort」，否则它会把人引去
   * 销毁一个本来什么都不需要做的 flow。这里 pin 住这三件事，防止被简化回去。
   */
  it('flow already active → 拒绝时要说清 /clear 无需命令、且不要 abort', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'r',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const result = await handleResume(repo.repoRoot, 'test-flow', 'test-sess', 'test-flow/aborted-x');
    expect(result.action).toBe('deny');
    const reason = (result as { action: 'deny'; reason: string }).reason;
    expect(reason).toMatch(/already active/i);
    expect(reason).toContain('/clear');          // 说清最常见的到达方式
    expect(reason).toContain('不要 abort');       // 拦住那条破坏性出路
    expect(reason).toContain('status');          // 给一个无害的下一步
  });

  it('branch does not exist → error', async () => {
    const repo = makeRepo();
    const result = await handleResume(repo.repoRoot, 'test-flow', 'test-sess', 'test-flow/aborted-nonexistent');
    expect(result.action).toBe('deny');
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/not found|does not exist/i);
  });

  it('branch exists but no snapshot → error', async () => {
    const repo = makeRepo();
    execSync('git checkout -b test-flow/aborted-no-snapshot', { cwd: repo.repoRoot });
    execSync('git checkout -', { cwd: repo.repoRoot });
    const result = await handleResume(repo.repoRoot, 'test-flow', 'test-sess', 'test-flow/aborted-no-snapshot');
    expect(result.action).toBe('deny');
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/snapshot|not found/i);
  });

  it('snapshot exists → restores active.json with correct current_stage', async () => {
    const repo = makeRepo();
    const snapshot = {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'resumed task',
      current_stage: 'work',
      base_sha: 'abc123',
      started_at: '2024-01-01T00:00:00.000Z',
      last_session_id: 'old-session',
      context_size: 50,
      context_wrap_up: { at_pct: null },
    };
    createAbortBranch(repo.repoRoot, 'test-flow', 'test-flow/aborted-2024-01-01T00-00-00', snapshot);
    const result = await handleResume(repo.repoRoot, 'test-flow', 'test-sess', 'test-flow/aborted-2024-01-01T00-00-00');
    expect(result.action).toBe('allow');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('work');
    expect(state!.requirement).toBe('resumed task');
  });

  // `abort` snapshots the whole state (JSON.stringify), so a snapshot taken after stage-3's
  // mark-base carries `base_sha_code`. This function rebuilds the state field by field and
  // used to drop it — silently losing the code-diff baseline on EVERY resume. stage-4 then
  // reads the injected paths block, finds no `base_sha_code`, and follows a recovery path
  // its own docs called "extremely rare".
  it('snapshot 带 base_sha_code → 必须一起恢复（丢了 stage-4 就没有 diff 基线）', async () => {
    const repo = makeRepo();
    createAbortBranch(repo.repoRoot, 'test-flow', 'test-flow/aborted-with-base', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow', requirement: 'r',
      current_stage: 'work', base_sha: 'abc123',
      base_sha_code: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      started_at: '2024-01-01T00:00:00.000Z', last_session_id: null, context_size: 0,
      context_wrap_up: { at_pct: null },
    });
    const result = await handleResume(repo.repoRoot, 'test-flow', 'test-sess', 'test-flow/aborted-with-base');
    expect(result.action).toBe('allow');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.base_sha_code).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    // 而且它要出现在注入的 [ai-flow:paths] 块里——那是 stage-4 唯一的读取处
    expect((result as { additionalContext: string }).additionalContext).toContain('deadbeefdead');
  });

  it('snapshot 没有 base_sha_code（mark-base 之前中止）→ 字段缺席，不是空串', async () => {
    const repo = makeRepo();
    createAbortBranch(repo.repoRoot, 'test-flow', 'test-flow/aborted-no-base', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow', requirement: 'r',
      current_stage: 'work', base_sha: 'abc123',
      started_at: '2024-01-01T00:00:00.000Z', last_session_id: null, context_size: 0,
      context_wrap_up: { at_pct: null },
    });
    await handleResume(repo.repoRoot, 'test-flow', 'test-sess', 'test-flow/aborted-no-base');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.base_sha_code).toBeUndefined();
  });

  it('last_session_id reset to null on restore (new session)', async () => {
    const repo = makeRepo();
    const snapshot = {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'resume test',
      current_stage: 'work',
      base_sha: 'abc',
      started_at: '2024-01-01T00:00:00.000Z',
      last_session_id: 'old-session-999',
      context_size: 0,
      context_wrap_up: { at_pct: null },
    };
    createAbortBranch(repo.repoRoot, 'test-flow', 'test-flow/aborted-resume-test', snapshot);
    await handleResume(repo.repoRoot, 'test-flow', 'test-sess', 'test-flow/aborted-resume-test');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.last_session_id).toBeNull();
  });

  it('cannot resume if another flow already active', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-active',
      flow_name: 'test-flow',
      requirement: 'active task',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const result = await handleResume(repo.repoRoot, 'test-flow', 'test-sess', 'test-flow/aborted-something');
    expect(result.action).toBe('deny');
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/already active|abort/i);
  });

  it('injects stage context from current stage prompt file', async () => {
    const repo = makeRepo();
    const snapshot = {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'with context',
      current_stage: 'work',
      base_sha: 'abc',
      started_at: '2024-01-01T00:00:00.000Z',
      last_session_id: null,
      context_size: 0,
      context_wrap_up: { at_pct: null },
    };
    createAbortBranch(repo.repoRoot, 'test-flow', 'test-flow/aborted-ctx-test', snapshot);
    const result = await handleResume(repo.repoRoot, 'test-flow', 'test-sess', 'test-flow/aborted-ctx-test');
    expect(result.action).toBe('allow');
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toContain('Stage: work');
  });

  it('resuming into a GATED stage injects the gate protocol note', async () => {
    const repo = makeRepo();
    const snapshot = {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'resume gated',
      current_stage: 'review', // review has gate: true in MINIMAL_CONFIG
      base_sha: 'abc',
      started_at: '2024-01-01T00:00:00.000Z',
      last_session_id: null,
      context_size: 0,
      context_wrap_up: { at_pct: null },
    };
    createAbortBranch(repo.repoRoot, 'test-flow', 'test-flow/aborted-gated', snapshot);
    const result = await handleResume(repo.repoRoot, 'test-flow', 'test-sess', 'test-flow/aborted-gated');
    expect(result.action).toBe('allow');
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toContain('Gate 协议');
  });

  it('seeds history_session_ids with the resuming session', async () => {
    const repo = makeRepo();
    const snapshot = {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'resume hist',
      current_stage: 'work',
      base_sha: 'abc',
      started_at: '2024-01-01T00:00:00.000Z',
      last_session_id: null,
      context_size: 0,
      context_wrap_up: { at_pct: null },
    };
    createAbortBranch(repo.repoRoot, 'test-flow', 'test-flow/aborted-hist', snapshot);
    await handleResume(repo.repoRoot, 'test-flow', 'sess-resume', 'test-flow/aborted-hist');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.history_session_ids).toEqual(['sess-resume']);
  });

  /**
   * `history_session_ids` 的契约（state.ts）是 append-only：范围是「这个 flow instance
   * 曾经的所有持有者」，而 resume 沿用快照的 flow_id / started_at，所以 abort/resume
   * 前后是同一个 instance，历史必须贯通。这里曾经写的是 `[sessionId]`（照抄 start.ts，
   * 那边新 flow 本来就没历史），于是每次 resume 都把已有历史冲掉。
   *
   * 上面那条「seeds ...」的快照里根本没有 history_session_ids 这个键，钉不住这条性质，
   * 所以下面三条分别覆盖：有历史 / resuming session 已在历史里 / 旧快照没这个键。
   */
  it('快照里已有历史 → 追加 resuming session，历史在前顺序不变', async () => {
    const repo = makeRepo();
    const snapshot = {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'resume hist append',
      current_stage: 'work',
      base_sha: 'abc',
      started_at: '2024-01-01T00:00:00.000Z',
      last_session_id: null,
      history_session_ids: ['sess-old-1', 'sess-old-2'],
      context_size: 0,
      context_wrap_up: { at_pct: null },
    };
    createAbortBranch(repo.repoRoot, 'test-flow', 'test-flow/aborted-hist-append', snapshot);
    await handleResume(repo.repoRoot, 'test-flow', 'sess-resume', 'test-flow/aborted-hist-append');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.history_session_ids).toEqual(['sess-old-1', 'sess-old-2', 'sess-resume']);
  });

  // 去重语义要和追加侧（session-handler.ts 的 `!historyIds.includes(session_id)`）一致。
  it('resuming session 已在快照历史里 → 不重复追加', async () => {
    const repo = makeRepo();
    const snapshot = {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'resume hist dedupe',
      current_stage: 'work',
      base_sha: 'abc',
      started_at: '2024-01-01T00:00:00.000Z',
      last_session_id: null,
      history_session_ids: ['sess-a', 'sess-resume'],
      context_size: 0,
      context_wrap_up: { at_pct: null },
    };
    createAbortBranch(repo.repoRoot, 'test-flow', 'test-flow/aborted-hist-dedupe', snapshot);
    await handleResume(repo.repoRoot, 'test-flow', 'sess-resume', 'test-flow/aborted-hist-dedupe');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.history_session_ids).toEqual(['sess-a', 'sess-resume']);
  });

  // 该字段是可选的，早于它存在的快照里没有这个键——那种快照必须仍然只记下 resuming session。
  it('快照里没有 history_session_ids 这个键 → 仍然只记下 resuming session', async () => {
    const repo = makeRepo();
    const snapshot: Record<string, unknown> = {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'resume hist legacy',
      current_stage: 'work',
      base_sha: 'abc',
      started_at: '2024-01-01T00:00:00.000Z',
      last_session_id: null,
      context_size: 0,
      context_wrap_up: { at_pct: null },
    };
    expect('history_session_ids' in snapshot).toBe(false);
    createAbortBranch(repo.repoRoot, 'test-flow', 'test-flow/aborted-hist-legacy', snapshot);
    await handleResume(repo.repoRoot, 'test-flow', 'sess-resume', 'test-flow/aborted-hist-legacy');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.history_session_ids).toEqual(['sess-resume']);
  });

  // 端到端：abort 写快照（整份 state 原样落盘）→ resume 读回，审计历史必须贯通。
  // 上面三条用手写快照，这条确认真实 abort 产出的快照也带得动历史。
  it('abort → resume 往返：审计历史贯通', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'roundtrip hist',
      current_stage: 'work',
      base_sha: execSync('git rev-parse HEAD', { cwd: repo.repoRoot, encoding: 'utf-8' }).trim(),
      history_session_ids: ['sess-first', 'sess-second'],
    });
    const abortResult = await handleAbort(repo.repoRoot, 'test-flow', 'sess-second', '--confirm');
    expect(abortResult.action).toBe('allow');
    const branch = execSync('git branch', { cwd: repo.repoRoot, encoding: 'utf-8' })
      .match(/test-flow\/aborted-[0-9T-]+/)?.[0];
    expect(branch).toBeTruthy();

    await handleResume(repo.repoRoot, 'test-flow', 'sess-third', branch!);
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.history_session_ids).toEqual(['sess-first', 'sess-second', 'sess-third']);
  });
});
