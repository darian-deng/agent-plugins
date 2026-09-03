import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { handleSessionStart } from '../src/lib/session-handler.js';
import { readActiveState } from '../src/lib/state.js';
import { createFlowTestRepo, writeActiveState, writeSignal, MINIMAL_CONFIG, GATED_CONFIG } from './fixtures/helpers.js';
import type { SessionStartInput } from '../src/lib/types.js';

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

function makeInput(repoRoot: string, sessionId: string, opts?: Partial<SessionStartInput>): SessionStartInput {
  return {
    hook_event_name: 'SessionStart',
    session_id: sessionId,
    cwd: repoRoot,
    ...opts,
  };
}

describe('handleSessionStart', () => {
  it('no active flow → null (no injection)', async () => {
    const repo = makeRepo();
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-1'));
    expect(out).toBeNull();
  });

  it('active flow, no gate → injects flow summary and stage prompt content', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build feature',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-new'));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toContain('test-flow');
    expect(out!.additionalContext).toContain('work');
    expect(out!.additionalContext).toContain('Stage: work');
  });

  it('active flow with gate pending (S1 + gate) → additionalContext mentions approve', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'review', // review has gate: true in MINIMAL_CONFIG
      base_sha: 'abc',
    });
    // MINIMAL_CONFIG: review is last stage (terminal), so signal must be 'flow-complete'
    writeSignal(repo.repoRoot, 'test-flow', 'flow-complete');
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-new'));
    expect(out!.additionalContext).toMatch(/gate|approve/i);
  });

  it("S1 self-heal: signal='done' + non-gate stage → stage advances, next stage injected", async () => {
    // Crash scenario: AI wrote 'done' but posttool didn't process it yet
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
    });
    writeSignal(repo.repoRoot, 'test-flow', 'done');
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-new'));
    expect(out).not.toBeNull();
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('review');
    expect(out!.additionalContext).toContain('review');
  });

  it('flow-complete signal at terminal (S2 self-heal) → active.json deleted', async () => {
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
      requirement: 'build',
      current_stage: 'review', // last stage
      base_sha: 'abc',
    });
    writeSignal(repo.repoRoot, 'test-flow', 'flow-complete');
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-new'));
    expect(out).not.toBeNull();
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).toBeNull();
    expect(out!.additionalContext).toMatch(/complete|完成/i);
  });

  it('stale signal (S3) → normal recovery, current stage injected', async () => {
    // Signal content doesn't match nextStage → treat as normal recovery
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
    });
    // Write stale/wrong signal content
    writeSignal(repo.repoRoot, 'test-flow', 'stale-content');
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-new'));
    expect(out).not.toBeNull();
    // Should stay at 'work', inject current stage prompt
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('work');
    expect(out!.additionalContext).toContain('work');
    expect(out!.additionalContext).toContain('Stage: work');
  });

  it('new session → context_wrap_up reset in state', async () => {
    const repo = makeRepo();
    // last_session_id: null represents a cleanly ended prior session (SessionEnd cleared it)
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: null,
      context_wrap_up: { at_pct: 80 },
    });
    await handleSessionStart(makeInput(repo.repoRoot, 'new-session'));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.context_wrap_up.at_pct).toBeNull();
  });

  it('same session → context_wrap_up NOT reset', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'same-session',
      context_wrap_up: { at_pct: 80 },
    });
    await handleSessionStart(makeInput(repo.repoRoot, 'same-session'));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.context_wrap_up.at_pct).toBe(80);
  });

  it('last_session_id null (post-resume) → context_wrap_up reset on new session', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: null,
      context_wrap_up: { at_pct: 80 },
    });
    await handleSessionStart(makeInput(repo.repoRoot, 'brand-new-session'));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.context_wrap_up.at_pct).toBeNull();
  });

  it('last_session_id updated in active.json after session start', async () => {
    const repo = makeRepo();
    // null = prior session ended cleanly; new session may claim ownership
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: null,
    });
    await handleSessionStart(makeInput(repo.repoRoot, 'new-sess-123'));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.last_session_id).toBe('new-sess-123');
  });

  it('startup + model with [1m] suffix → context_size saved as 1_000_000', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      context_size: 0,
    });
    await handleSessionStart(makeInput(repo.repoRoot, 'sess-new', {
      source: 'startup',
      model: 'claude-sonnet-4-6[1m]',
    }));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.context_size).toBe(1_000_000);
  });

  it('non-startup source → context_size not updated even if model provided', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      context_size: 42,
    });
    await handleSessionStart(makeInput(repo.repoRoot, 'sess-new', {
      source: 'clear',
      model: 'claude-sonnet-4-6[1m]',
    }));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.context_size).toBe(42); // unchanged
  });

  it('startup without model → context_size set to DEFAULT (1M)', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      context_size: 99,
    });
    await handleSessionStart(makeInput(repo.repoRoot, 'sess-new', { source: 'startup' }));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.context_size).toBe(1_000_000);
  });

  // These two used to seed `context_blocked` directly. That field is gone — the
  // wrap-up latch is `context_wrap_up.at_pct` — so they now write the shape the
  // TWO-LEVEL engine left on disk and assert SessionStart still behaves. Real
  // flows are mid-run with state files in that shape, and this is the path they
  // take on their first SessionStart under the new engine.
  function writeLegacyActiveState(repoRoot: string, ownerSessionId: string | null): void {
    const dir = join(repoRoot, '.ai-flow', 'test-flow', 'state');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'active.json'), JSON.stringify({
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      started_at: '2024-01-01T00:00:00Z',
      last_session_id: ownerSessionId,
      context_size: 0,
      context_blocked: true,
      context_warning: { warned: true, warned_at_pct: 70, warned_at: '2024-01-01T00:00:00Z', block_reminded_at_pct: 72 },
    }, null, 2));
  }

  it('new session on a legacy active.json → wrap-up latch cleared, old keys gone', async () => {
    const repo = makeRepo();
    // null = prior session ended cleanly; new session may claim ownership
    writeLegacyActiveState(repo.repoRoot, null);
    await handleSessionStart(makeInput(repo.repoRoot, 'new-session'));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.context_wrap_up).toEqual({ at_pct: null });
    // SessionStart patches, and patchActiveState spreads the normalized read, so
    // the removed keys must not survive on disk.
    const onDisk = JSON.parse(readFileSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'active.json'), 'utf-8'));
    expect(onDisk).not.toHaveProperty('context_blocked');
    expect(onDisk).not.toHaveProperty('context_warning');
  });

  it('same session on a legacy active.json → latch carried over, not cleared', async () => {
    const repo = makeRepo();
    writeLegacyActiveState(repo.repoRoot, 'same-session');
    await handleSessionStart(makeInput(repo.repoRoot, 'same-session'));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    // The old file had context_blocked: true, so the wrap-up had genuinely started
    // at 70% — pretool must keep refusing code writes and keep naming that level.
    // toEqual: `block_reminded_at_pct: 72` throttled a repeat reminder that no
    // longer exists, so nothing on the new object may carry it.
    expect(state!.context_wrap_up).toEqual({ at_pct: 70 });
  });

  it('missing stage prompt file → injects summary without crash', async () => {
    const repo = makeRepo();
    execSync(`rm -f "${join(repo.flowDir, 'stages', 'work.md')}"`, { stdio: 'pipe' });
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-new'));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toContain('test-flow');
  });

  // ── Session mutex ──────────────────────────────────────────────────────────

  it('different session owns flow → read-only context, no stage prompt, state unchanged', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'owner-session',
    });
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'intruder-session'));
    expect(out).not.toBeNull();
    // Read-only notice: names the flow, states the modify ban, points at recovery.
    expect(out!.additionalContext).toContain('test-flow');
    expect(out!.additionalContext).toMatch(/只读|仅可读取|禁止修改/);
    expect(out!.additionalContext).toContain('last_session_id');
    // Must NOT inject the stage prompt body — the observer must not drive the flow.
    expect(out!.additionalContext).not.toContain('Do the work.');
    // State must NOT be modified — owner session id preserved and intruder not in history.
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.last_session_id).toBe('owner-session');
    expect(state!.history_session_ids ?? []).not.toContain('intruder-session');
  });

  it('same session re-enters → no mutex block', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'owner-session',
    });
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'owner-session'));
    // Should not contain block message — use a stable marker, not the Chinese wording
    expect(out!.additionalContext).not.toContain('last_session_id');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.last_session_id).toBe('owner-session');
  });

  it('history_session_ids accumulates across sessions', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: null,
    });
    await handleSessionStart(makeInput(repo.repoRoot, 'sess-a'));
    // Simulate clean handoff: SessionEnd would set last_session_id to null
    writeActiveState(repo.repoRoot, 'test-flow', {
      ...(await readActiveState(repo.repoRoot, 'test-flow'))!,
      last_session_id: null,
    });
    await handleSessionStart(makeInput(repo.repoRoot, 'sess-b'));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.history_session_ids).toContain('sess-a');
    expect(state!.history_session_ids).toContain('sess-b');
  });

  it('same session re-entry does not duplicate in history_session_ids', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'sess-a',
      history_session_ids: ['sess-a'],
    });
    await handleSessionStart(makeInput(repo.repoRoot, 'sess-a'));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.history_session_ids!.filter((s) => s === 'sess-a').length).toBe(1);
  });

  // ── New protocol: AI writes 'done', session self-heal handles it ──

  it("signal='done' + non-gate stage → self-heal advances to next stage", async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow',
      requirement: 'build', current_stage: 'work', base_sha: 'abc',
    });
    writeSignal(repo.repoRoot, 'test-flow', 'done');
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-new'));
    expect(out).not.toBeNull();
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('review');
    expect(out!.additionalContext).toContain('review');
  });

  it("signal='done' + gate stage → session shows gate pending recovery", async () => {
    // GATED_CONFIG: work has gate=true
    const repo = createFlowTestRepo('test-flow', GATED_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow',
      requirement: 'build', current_stage: 'work', base_sha: 'abc',
    });
    writeSignal(repo.repoRoot, 'test-flow', 'done');
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-new'));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toMatch(/gate|approve/i);
    // Stage should NOT have advanced
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('work');
  });
});

// 同一 git 仓库的两个检出互锁的那个形态（实测事故：开发者手建两条独立开发线，A 里跑着 flow，
// 于是 B 里整个 session 只读，而消息说的是「当前工程已在进行流程」——读起来像 B 自己在跑）。
describe('handleSessionStart — 跨检出（flow 的锚点在另一个检出）', () => {
  function makeCrossCheckout(ownerOfA: string | null) {
    const repo = makeRepo();
    const parent = mkdtempSync(join(tmpdir(), 'ai-flow-xco-sess-'));
    const a = join(parent, 'line-a');
    const b = join(parent, 'line-b');
    execSync(`git worktree add -q "${a}" -b feat/line-a`, { cwd: repo.repoRoot });
    execSync(`git worktree add -q "${b}" -b feat/line-b`, { cwd: repo.repoRoot });
    writeActiveState(a, 'test-flow', {
      flow_id: 'flow-in-a',
      flow_name: 'test-flow',
      requirement: 'A 那条开发线的需求',
      current_stage: 'work',
      base_sha: 'aaa111',
      last_session_id: ownerOfA,
    });
    // 只删目录：makeRepo 的清理排在前面，已经把主检出删了（见 userprompt.test.ts 同处注释）。
    cleanups.push(() => execSync(`rm -rf "${parent}"`));
    return { a, b };
  }

  it('A 有主 → B 只读，消息点名两个检出并给出可执行出路（不再说「当前工程」）', async () => {
    const { a, b } = makeCrossCheckout('owner-in-a');
    const out = await handleSessionStart(makeInput(b, 'sess-in-b'));
    expect(out).not.toBeNull();
    const ctx = out!.additionalContext;
    expect(ctx).toContain(a);                       // flow 的锚点
    expect(ctx).toContain(b);                       // 本 session 的 cwd
    expect(ctx).toContain('mv ');                   // 出路可执行，不是「请自行处理」
    expect(ctx).toMatch(/误锁|不在你现在这个检出/);
    // 「当前工程」在这个形态下是错的：它读起来像 B 自己在跑流程。
    expect(ctx).not.toContain('当前工程已在进行流程');
    // ⛔ 不能建议在本检出 abort——那会销毁 A 的流程状态。
    expect(ctx).toMatch(/不要在本检出执行|去它自己的检出/);
    expect(out!.systemMessage).toMatch(/另一个检出/);
    // 仍然不注入 stage 提示词，也不动 A 的状态。
    expect(ctx).not.toContain('Do the work.');
    const st = await readActiveState(a, 'test-flow');
    expect(st!.last_session_id).toBe('owner-in-a');
  });

  it('A 无主 → B 接管时注入必须先说「锚点不在这个检出」（否则产物静默写到 A）', async () => {
    const { a, b } = makeCrossCheckout(null);
    const out = await handleSessionStart(makeInput(b, 'sess-in-b'));
    expect(out).not.toBeNull();
    const ctx = out!.additionalContext;
    expect(ctx).toContain('锚点');
    expect(ctx).toContain(a);
    expect(ctx).toContain(b);
    expect(ctx).toMatch(/先停下告知|别在这个 flow 上动手/);
    // 接管本身仍然发生（这一轮只加告知，不改接管行为）
    const st = await readActiveState(a, 'test-flow');
    expect(st!.last_session_id).toBe('sess-in-b');
  });

  // `viaSibling` 在 flow 自己的票树里同样会命中——那是这条解析路由存在的**理由**（票树的
  // `.ai-flow/` 是被追踪的副本、没有自己的 state/，不放行则票树里每个子代理都 fail-OPEN）。
  // 但票树里「锚点在别处」是预期形态，那段「先停下告知、考虑把状态挪走」的提示在那里是有害的：
  // 要挪的正是打开这棵树的那条 flow 的状态。所以判据是两半——跨检出 **且** 不在票树里。
  it('flow 自己的票树里不打这段警告，但仍必须解析到 flow（fail-OPEN 保护不能丢）', async () => {
    const repo = makeRepo();
    // 落点命名由 worktree.cjs 决定：`<repo 同级>/<repo 名>.ai-flow-worktrees/<flow_id>-<name>`
    const lanes = repo.repoRoot + '.ai-flow-worktrees';
    const t = join(lanes, 'flow-abc-T1');
    execSync(`git worktree add -q "${t}" -b wt/t1`, { cwd: repo.repoRoot });
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'flow-abc', flow_name: 'test-flow', requirement: 'r',
      current_stage: 'work', base_sha: 'ccc333', last_session_id: null,
    });
    cleanups.push(() => execSync(`rm -rf "${lanes}"`));

    const out = await handleSessionStart(makeInput(t, 'sess-in-ticket-tree'));
    expect(out).not.toBeNull();                                   // 解析到了 flow（没 fail-OPEN）
    expect(out!.additionalContext).not.toContain('不在你现在这个检出里');
    expect(out!.additionalContext).not.toContain('先停下告知');
  });

  it('同检出不带这段警告（别把正常路径也灌上跨检出噪音）', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'f-here', flow_name: 'test-flow', requirement: 'r',
      current_stage: 'work', base_sha: 'bbb222', last_session_id: null,
    });
    const out = await handleSessionStart(makeInput(repo.repoRoot, 'sess-here'));
    expect(out!.additionalContext).not.toContain('不在你现在这个检出里');
  });
});
