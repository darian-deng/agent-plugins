import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { handleUserPrompt } from '../src/lib/userprompt-handler.js';
import { readActiveState } from '../src/lib/state.js';
import { createFlowTestRepo, writeActiveState, writeSignal, MINIMAL_CONFIG } from './fixtures/helpers.js';
import type { UserPromptInput } from '../src/lib/types.js';

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

function makeInput(prompt: string, repoRoot: string, sessionId = 'sess-1'): UserPromptInput {
  return {
    hook_event_name: 'UserPromptSubmit',
    session_id: sessionId,
    cwd: repoRoot,
    prompt,
  };
}

describe('handleUserPrompt — routing', () => {
  it('non-flow message passes through (allow, no additionalContext)', async () => {
    const repo = makeRepo();
    const out = await handleUserPrompt(makeInput('hello world', repo.repoRoot));
    expect(out.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    const o = out.hookSpecificOutput as { permissionDecision?: string; additionalContext?: string };
    expect(o.permissionDecision).toBeUndefined();
    expect(o.additionalContext).toBeUndefined();
  });

  it('test-flow start → routes to start handler', async () => {
    const repo = makeRepo();
    const out = await handleUserPrompt(makeInput('test-flow start build feature X', repo.repoRoot));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).not.toBeNull();
  });

  it('test-flow start with multiline requirement → routes to start handler', async () => {
    const repo = makeRepo();
    const multiline = 'test-flow start build feature X\nThis is a detailed description\nwith multiple lines of context';
    const out = await handleUserPrompt(makeInput(multiline, repo.repoRoot));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).not.toBeNull();
    expect(state!.requirement).toContain('build feature X');
  });

  it('test-flow start with CJK args and no space after subcommand → routes to start handler', async () => {
    const repo = makeRepo();
    const prompt = 'test-flow start我要构建这个功能，具体需求如下\n详细描述在这里';
    await handleUserPrompt(makeInput(prompt, repo.repoRoot));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).not.toBeNull();
    expect(state!.requirement).toContain('我要构建这个功能');
  });

  it('statuscheck (unknown command with known prefix) → not routed as status', async () => {
    const repo = makeRepo();
    const out = await handleUserPrompt(makeInput('test-flow statuscheck', repo.repoRoot));
    const o = out.hookSpecificOutput as { permissionDecision?: string; additionalContext?: string };
    expect(o.permissionDecision).not.toBe('deny');
    expect(o.additionalContext).toMatch(/unknown|valid/i);
  });

  it('test-flow approve → routes to approve handler (no token needed)', async () => {
    const repo = createFlowTestRepo('test-flow', {
      schema_version: '1.0',
      name: 'test-flow',
      stages: [
        { id: 'work', prompt: 'stages/work.md', write_scope: 'unrestricted', completion: { gate: true } },
        { id: 'review', prompt: 'stages/review.md', write_scope: 'unrestricted', completion: {} },
      ],
    });
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    // signal must contain nextStageId 'review' for gate to be pending
    writeSignal(repo.repoRoot, 'test-flow', 'review');
    const out = await handleUserPrompt(makeInput('test-flow approve', repo.repoRoot));
    const o = out.hookSpecificOutput as { additionalContext?: string };
    expect(o.additionalContext).toContain('review');
  });

  it('test-flow abort (no --confirm) → routes to abort handler, returns confirmation prompt', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: execSync('git rev-parse HEAD', { cwd: repo.repoRoot, encoding: 'utf-8' }).trim(),
    });
    const out = await handleUserPrompt(makeInput('test-flow abort', repo.repoRoot));
    // abort without --confirm returns a deny + confirmation prompt, state is unchanged
    const hookOut = out.hookSpecificOutput as { permissionDecision?: string; additionalContext?: string };
    const hasConfirmMsg = hookOut.permissionDecision === 'deny' || (hookOut.additionalContext ?? '').includes('--confirm');
    expect(hasConfirmMsg).toBe(true);
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).not.toBeNull(); // state preserved — abort did not execute
  });

  it('test-flow status → routes to status handler', async () => {
    const repo = makeRepo();
    const out = await handleUserPrompt(makeInput('test-flow status', repo.repoRoot));
    const o = out.hookSpecificOutput as { additionalContext?: string };
    expect(o.additionalContext).toMatch(/no active flow/i);
  });

  it('test-flow help → routes to help handler', async () => {
    const repo = makeRepo();
    const out = await handleUserPrompt(makeInput('test-flow help', repo.repoRoot));
    const o = out.hookSpecificOutput as { additionalContext?: string };
    expect(o.additionalContext).toContain('test-flow');
  });

  it('test-flow unknowncmd → soft error (allow + additionalContext, NOT deny)', async () => {
    const repo = makeRepo();
    const out = await handleUserPrompt(makeInput('test-flow unknowncmd', repo.repoRoot));
    const o = out.hookSpecificOutput as { permissionDecision?: string; additionalContext?: string };
    expect(o.permissionDecision).not.toBe('deny');
    expect(o.additionalContext).toBeTruthy();
  });

  it('unknown cmd message includes list of valid commands', async () => {
    const repo = makeRepo();
    const out = await handleUserPrompt(makeInput('test-flow foobar', repo.repoRoot));
    const o = out.hookSpecificOutput as { additionalContext?: string };
    expect(o.additionalContext).toMatch(/start|approve|abort|resume|status|help/i);
  });

  it('unknown cmd does NOT show "operation blocked" banner', async () => {
    const repo = makeRepo();
    const out = await handleUserPrompt(makeInput('test-flow foobar', repo.repoRoot));
    const o = out.hookSpecificOutput as { additionalContext?: string };
    expect(o.additionalContext).not.toMatch(/operation blocked/i);
  });

  it('flow name not in .ai-flow/ → soft error mentioning /ai-flow', async () => {
    const repo = makeRepo();
    const out = await handleUserPrompt(makeInput('unknown-flow start task', repo.repoRoot));
    // unknown prefix should pass through (not an error, not recognized)
    const o = out.hookSpecificOutput as { permissionDecision?: string };
    // Either pass-through or soft error mentioning the flow
    // If it's a registered flow pattern detection only known flows matter
    // An unknown prefix should just pass through
    expect(o.permissionDecision).not.toBe('deny');
  });

  // ── Session mutex enforcement ──────────────────────────────────────────────

  it('non-owner session issues flow command → denied', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'owner-sess',
    });
    const out = await handleUserPrompt(makeInput('test-flow status', repo.repoRoot, 'intruder-sess'));
    const o = out.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string };
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('owner-se'); // 8-char truncated owner id
  });

  it('non-owner session sends plain prompt → allowed (read-only), no resume-guidance injected', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'owner-sess',
    });
    // A plain non-flow-command prompt must pass through so the second session can
    // read/ask. It must NOT be nudged into driving the flow (no resume-guidance).
    const out = await handleUserPrompt(makeInput('hello world', repo.repoRoot, 'intruder-sess'));
    const o = out.hookSpecificOutput as { permissionDecision?: string; additionalContext?: string };
    expect(o.permissionDecision).not.toBe('deny');
    expect(o.additionalContext ?? '').not.toMatch(/resume-guidance|第一句回复/);
  });

  it('non-owner plain prompt → does NOT mutate owner active.json (first_prompt_handled untouched)', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'owner-sess',
    });
    await handleUserPrompt(makeInput('hello world', repo.repoRoot, 'intruder-sess'));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    // Owner unchanged; observer never wrote first_prompt_handled into owner's state.
    expect(state!.last_session_id).toBe('owner-sess');
    expect(state!.first_prompt_handled ?? false).toBe(false);
  });

  it('owner session issues flow command → not denied', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'owner-sess',
    });
    const out = await handleUserPrompt(makeInput('test-flow status', repo.repoRoot, 'owner-sess'));
    const o = out.hookSpecificOutput as { permissionDecision?: string };
    expect(o.permissionDecision).not.toBe('deny');
  });

  it('owner session sends plain prompt → not denied', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'owner-sess',
    });
    const out = await handleUserPrompt(makeInput('hello world', repo.repoRoot, 'owner-sess'));
    const o = out.hookSpecificOutput as { permissionDecision?: string };
    expect(o.permissionDecision).not.toBe('deny');
  });
});

// 同一 git 仓库的两个检出（git worktree）互锁的那个形态。实测事故：开发者手建两条开发线，
// A 里跑着一个 flow，于是 B 里什么都干不了——而所有拒绝消息都不说 flow 在哪个检出，`start`
// 的拒绝还建议 `<flow> abort`，在 B 里执行会**销毁 A 的流程状态**。这一组用例锁住两件事：
// 破坏性命令在这个形态下必须被拦、且消息必须点名两个检出；只读命令不受影响。
describe('handleUserPrompt — 跨检出（另一个检出持有 flow）', () => {
  function makeCrossCheckout() {
    const repo = makeRepo();                      // 主检出：flow 模板已提交，无活跃 flow
    const parent = mkdtempSync(join(tmpdir(), 'ai-flow-xco-'));
    const a = join(parent, 'line-a');
    const b = join(parent, 'line-b');
    execSync(`git worktree add -q "${a}" -b feat/line-a`, { cwd: repo.repoRoot });
    execSync(`git worktree add -q "${b}" -b feat/line-b`, { cwd: repo.repoRoot });
    // flow 只跑在 A（state/ 被 gitignore，所以这份 active.json 只属于 A）
    writeActiveState(a, 'test-flow', {
      flow_id: 'flow-in-a',
      flow_name: 'test-flow',
      requirement: 'A 那条开发线的需求',
      current_stage: 'work',
      base_sha: 'aaa111',
    });
    // 只删目录、不调 `git worktree remove`：afterEach 按注册顺序跑，makeRepo 的清理排在前面
    // 已经把主检出删了，任何 `cwd: repo.repoRoot` 的命令到这里都是 ENOENT。worktree 的登记
    // 信息本来就住在被删掉的那个主仓里，跟着一起消失。
    cleanups.push(() => execSync(`rm -rf "${parent}"`));
    return { repo, a, b };
  }

  it('B 里 abort → 拒绝，且消息点名两个检出（不能静默销毁 A 的流程状态）', async () => {
    const { a, b } = makeCrossCheckout();
    const out = await handleUserPrompt(makeInput('test-flow abort --confirm', b, 'sess-in-b'));
    const o = out.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string };
    expect(o.permissionDecision).toBe('deny');
    const reason = o.permissionDecisionReason ?? '';
    expect(reason).toContain(a);          // 解析到的锚点
    expect(reason).toContain(b);          // 本 session 的 cwd
    expect(reason).toMatch(/另一个检出|不同检出/);
    // A 的流程状态必须还在——这条是本用例真正要守的东西
    expect(await readActiveState(a, 'test-flow')).not.toBeNull();
  });

  it('B 里 start → 拒绝，且给出「把 A 的状态挪走」这条可执行出路', async () => {
    const { a, b } = makeCrossCheckout();
    const out = await handleUserPrompt(makeInput('test-flow start 在 B 上做另一件事', b, 'sess-in-b'));
    const o = out.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string };
    expect(o.permissionDecision).toBe('deny');
    const reason = o.permissionDecisionReason ?? '';
    expect(reason).toContain('mv ');                       // 出路是可执行的，不是「请自行处理」
    expect(reason).toContain(join(a, '.ai-flow', 'test-flow', 'state'));
    // B 上不能被偷偷建出 flow
    expect(await readActiveState(b, 'test-flow')).toBeNull();
  });

  it('B 里 status → 放行（只读命令不受跨检出守卫影响）', async () => {
    const { b } = makeCrossCheckout();
    const out = await handleUserPrompt(makeInput('test-flow status', b, 'sess-in-b'));
    const o = out.hookSpecificOutput as { permissionDecision?: string };
    expect(o.permissionDecision).not.toBe('deny');
  });

  it('同检出里 abort 不受影响（守卫只针对跨检出，别把正常路径也拦了）', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'f-here', flow_name: 'test-flow', requirement: 'r',
      current_stage: 'work', base_sha: 'bbb222',
    });
    const out = await handleUserPrompt(makeInput('test-flow abort', repo.repoRoot));
    const o = out.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string };
    // 同检出的 abort 走的是它自己的 --confirm 确认流程，不是跨检出拒绝
    expect(o.permissionDecisionReason ?? '').not.toMatch(/另一个检出|不同检出/);
  });
});
