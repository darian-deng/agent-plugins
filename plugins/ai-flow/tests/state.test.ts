import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync, execFileSync } from 'child_process';
import {
  readActiveState,
  writeActiveState,
  patchActiveState,
  hasActiveFlow,
  readSignal,
  writeSignalFile,
  isGatePending,
  appendLog,
  nextStage,
} from '../src/lib/state.js';
import type { ActiveState } from '../src/lib/state.js';
import { MINIMAL_CONFIG, GATED_CONFIG } from './fixtures/helpers.js';

let tmpDirs: string[] = [];

function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ai-flow-state-test-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs) execSync(`rm -rf "${d}"`);
  tmpDirs = [];
});

function makeActiveState(overrides?: Partial<ActiveState>): ActiveState {
  return {
    flow_id: 'test-abc123',
    flow_name: 'test-flow',
    requirement: 'add feature X',
    current_stage: 'work',
    base_sha: 'abc123',
    started_at: '2024-01-01T00:00:00.000Z',
    last_session_id: null,
    context_size: 0,
    context_warning: { warned: false, warned_at_pct: null, warned_at: null },
    context_blocked: false,
    ...overrides,
  };
}

describe('readActiveState', () => {
  it('returns null for nonexistent file', async () => {
    const root = makeTmp();
    const result = await readActiveState(root, 'test-flow');
    expect(result).toBeNull();
  });

  it('returns parsed state for valid file', async () => {
    const root = makeTmp();
    const stateDir = join(root, '.ai-flow', 'test-flow', 'state');
    mkdirSync(stateDir, { recursive: true });
    const state = makeActiveState();
    writeFileSync(join(stateDir, 'active.json'), JSON.stringify(state));
    const result = await readActiveState(root, 'test-flow');
    expect(result).toMatchObject(state);
  });

  it('returns null for corrupted JSON', async () => {
    const root = makeTmp();
    const stateDir = join(root, '.ai-flow', 'test-flow', 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'active.json'), '{ not valid json ');
    const result = await readActiveState(root, 'test-flow');
    expect(result).toBeNull();
  });
});

describe('writeActiveState', () => {
  it('creates directory if not exists', async () => {
    const root = makeTmp();
    const state = makeActiveState();
    await writeActiveState(root, 'test-flow', state);
    expect(existsSync(join(root, '.ai-flow', 'test-flow', 'state', 'active.json'))).toBe(true);
  });

  it('writeActiveState + readActiveState roundtrip', async () => {
    const root = makeTmp();
    const state = makeActiveState({ requirement: 'build something cool', current_stage: 'review' });
    await writeActiveState(root, 'test-flow', state);
    const loaded = await readActiveState(root, 'test-flow');
    expect(loaded).toEqual(state);
  });
});

describe('patchActiveState', () => {
  it('merges only the given fields, leaving the rest as they are on disk', async () => {
    const root = makeTmp();
    await writeActiveState(root, 'test-flow', makeActiveState({ base_sha_code: 'CODE_SHA' }));
    const merged = await patchActiveState(root, 'test-flow', { current_stage: 'review' });
    expect(merged!.current_stage).toBe('review');
    expect(merged!.base_sha_code).toBe('CODE_SHA');
    expect((await readActiveState(root, 'test-flow'))!.base_sha_code).toBe('CODE_SHA');
  });

  it('returns null and creates nothing when active.json is absent', async () => {
    const root = makeTmp();
    const result = await patchActiveState(root, 'test-flow', { current_stage: 'review' });
    expect(result).toBeNull();
    expect(existsSync(join(root, '.ai-flow', 'test-flow', 'state', 'active.json'))).toBe(false);
  });

  it('derives the patch from the state at write time, not from the caller', async () => {
    const root = makeTmp();
    await writeActiveState(root, 'test-flow', makeActiveState({ last_session_id: 'owner' }));
    const seen: Array<string | null> = [];
    await patchActiveState(root, 'test-flow', (cur) => {
      seen.push(cur.last_session_id);
      return { last_session_id: 'taken-over' };
    });
    expect(seen).toEqual(['owner']);
  });

  // The failure mode this whole mechanism exists for. PostToolUse fires for
  // subagent tool calls too, so a hook can still be holding an ActiveState it read
  // seconds ago while the owner advances the stage and captures base_sha_code.
  it('a lagging writer neither rolls back current_stage nor erases base_sha_code', async () => {
    const root = makeTmp();
    await writeActiveState(root, 'test-flow', makeActiveState());
    const stale = (await readActiveState(root, 'test-flow'))!;

    await patchActiveState(root, 'test-flow', { current_stage: 'review' });
    await patchActiveState(root, 'test-flow', { base_sha_code: 'CODE_SHA' });

    const warning = { warned: true, warned_at_pct: 62, warned_at: '2024-01-01T00:00:00.000Z' };
    await patchActiveState(root, 'test-flow', { context_warning: warning });

    const after = (await readActiveState(root, 'test-flow'))!;
    expect(after.current_stage).toBe('review');
    expect(after.base_sha_code).toBe('CODE_SHA');
    expect(after.context_warning.warned_at_pct).toBe(62);

    // Same intent expressed as a whole-document write — the shape every mutating
    // call site used to have. It loses both fields, which is why writeActiveState
    // is reserved for start/resume.
    await writeActiveState(root, 'test-flow', { ...stale, context_warning: warning });
    const clobbered = (await readActiveState(root, 'test-flow'))!;
    expect(clobbered.current_stage).toBe('work');
    expect(clobbered.base_sha_code).toBeUndefined();
  });

  it('concurrent patches all land — every writer keeps its own field', async () => {
    const root = makeTmp();
    await writeActiveState(root, 'test-flow', makeActiveState());
    await Promise.all([
      patchActiveState(root, 'test-flow', { current_stage: 'review' }),
      patchActiveState(root, 'test-flow', { base_sha_code: 'CODE_SHA' }),
      patchActiveState(root, 'test-flow', { context_blocked: true }),
      patchActiveState(root, 'test-flow', { first_prompt_handled: true }),
    ]);
    const after = (await readActiveState(root, 'test-flow'))!;
    expect(after.current_stage).toBe('review');
    expect(after.base_sha_code).toBe('CODE_SHA');
    expect(after.context_blocked).toBe(true);
    expect(after.first_prompt_handled).toBe(true);
  });

  it('serializes concurrent append-style patches (8 in flight, 8 recorded)', async () => {
    const root = makeTmp();
    await writeActiveState(root, 'test-flow', makeActiveState({ history_session_ids: [] }));
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        patchActiveState(root, 'test-flow', (cur) => ({
          history_session_ids: [...(cur.history_session_ids ?? []), `sess-${i}`],
        }))
      )
    );
    const after = (await readActiveState(root, 'test-flow'))!;
    expect(after.history_session_ids).toHaveLength(8);
    expect(new Set(after.history_session_ids)).toEqual(
      new Set(Array.from({ length: 8 }, (_, i) => `sess-${i}`))
    );
  });

  it('proceeds when the lock file was orphaned by a dead hook process', async () => {
    const root = makeTmp();
    await writeActiveState(root, 'test-flow', makeActiveState());
    const lockPath = join(root, '.ai-flow', 'test-flow', 'state', 'active.json.lock');
    writeFileSync(lockPath, '');
    // Backdate past the staleness cutoff so the lock is broken rather than waited on.
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    const merged = await patchActiveState(root, 'test-flow', { current_stage: 'review' });
    expect(merged!.current_stage).toBe('review');
  });
});

describe('hasActiveFlow', () => {
  it('returns null with 0 flows', async () => {
    const root = makeTmp();
    const result = await hasActiveFlow(root);
    expect(result).toBeNull();
  });

  it('returns flow info with 1 active flow', async () => {
    const root = makeTmp();
    const state = makeActiveState({ flow_name: 'my-flow' });
    mkdirSync(join(root, '.ai-flow', 'my-flow', 'state'), { recursive: true });
    writeFileSync(
      join(root, '.ai-flow', 'my-flow', 'state', 'active.json'),
      JSON.stringify(state)
    );
    const result = await hasActiveFlow(root);
    expect(result).not.toBeNull();
    expect(result!.flowName).toBe('my-flow');
    expect(result!.state.flow_id).toBe('test-abc123');
  });

  it('scans multiple flows and returns the active one', async () => {
    const root = makeTmp();
    mkdirSync(join(root, '.ai-flow', 'flow-a', 'state'), { recursive: true });
    const state = makeActiveState({ flow_name: 'flow-b' });
    mkdirSync(join(root, '.ai-flow', 'flow-b', 'state'), { recursive: true });
    writeFileSync(
      join(root, '.ai-flow', 'flow-b', 'state', 'active.json'),
      JSON.stringify(state)
    );
    const result = await hasActiveFlow(root);
    expect(result!.flowName).toBe('flow-b');
  });

  // 一个 `.ai-flow` 但没有 active flow 时，walk-up 默认就此结束——monorepo 子项目的
  // 空闲锚点绝不能解析到父项目的 flow。linked worktree 是唯一的例外：它那份
  // `.ai-flow/` 是主仓的 tracked 副本，`state/` 被 gitignore 所以永远拿不到
  // active.json；不放行就等于每个在 worktree 里干活的子代理都解析不到 flow，
  // 于是 handlePreTool 在任何守卫之前早退——控制面保护、signal 拦截、写作用域、
  // context 统计全部静默关闭（fail-OPEN）。
  //
  // 这些用例建**真** git worktree 而不是手写 `.git` 文件：判据现在问 git
  // （`rev-parse --git-dir --git-common-dir`），而手写文件模拟不出 monorepo 布局下
  // 「锚点比 .git 文件深好几层」这个真实形态。
  describe('walk-up 越过 linked worktree', () => {
    function gitInit(dir: string): void {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
    }

    function writeFlowAt(anchor: string, withActive: boolean): void {
      mkdirSync(join(anchor, '.ai-flow', 'parent-flow', 'state'), { recursive: true });
      // config.json 代表 `.ai-flow/<flow>/` 里那些**被 git 跟踪**的文件（config /
      // stages / scripts / references）。它们是 worktree 里也会有一份 `.ai-flow` 的原因，
      // 而 `state/` 被 gitignore、所以那份副本永远拿不到 active.json。
      writeFileSync(join(anchor, '.ai-flow', 'parent-flow', 'config.json'), '{}\n');
      if (withActive) {
        writeFileSync(
          join(anchor, '.ai-flow', 'parent-flow', 'state', 'active.json'),
          JSON.stringify(makeActiveState({ flow_name: 'parent-flow' }))
        );
      }
    }

    it('worktree 里的锚点（monorepo 布局，比 .git 深两层）→ 上溯到主仓 flow', async () => {
      const gitRoot = makeTmp();
      gitInit(gitRoot);
      const anchor = join(gitRoot, 'packages', 'app');
      mkdirSync(anchor, { recursive: true });
      writeFlowAt(anchor, true);
      // 这条 gitignore 规则由 `/ai-flow:add` 写入，而 worktree 并行**依赖**它：
      // 没有它，active.json 会被提交进去，worktree 里就有一份陈旧副本，子代理会
      // 解析到它自己那份、而不是主仓的真状态。
      writeFileSync(join(gitRoot, '.gitignore'), '**/.ai-flow/**/state/\n.worktrees/\n');
      writeFileSync(join(gitRoot, 'seed.txt'), 'x');
      execFileSync('git', ['add', '-A'], { cwd: gitRoot });
      execFileSync('git', ['commit', '-qm', 'base'], { cwd: gitRoot });

      // `git worktree add` 检出整个仓库，所以锚点副本在 <wt>/packages/app —— `.git`
      // 文件在 <wt>，不在锚点旁边。这正是旧判据漏掉的形态。
      const wt = join(anchor, '.worktrees', 'f1-T1');
      execFileSync('git', ['worktree', 'add', '-q', wt, '-b', 'wt/f1-T1'], { cwd: gitRoot });
      const wtAnchor = join(wt, 'packages', 'app');
      expect(existsSync(join(wtAnchor, '.ai-flow'))).toBe(true);   // tracked 副本在
      expect(existsSync(join(wtAnchor, '.git'))).toBe(false);      // 但 .git 不在这层

      const result = await hasActiveFlow(wtAnchor);
      expect(result).not.toBeNull();
      expect(result!.flowName).toBe('parent-flow');
      expect(realpathSync(result!.repoRoot)).toBe(realpathSync(anchor));

      execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: gitRoot });
    });

    // worktree 落在**仓库之外**时同样要解析到主仓锚点。向上走到 `.ai-flow` 副本后继续
    // 上溯只在「worktree 嵌在主仓里」时才碰得到主仓锚点；落点一旦搬出仓库，那条路径
    // 一直走到文件系统根都找不到 flow，于是每个在 worktree 里干活的子代理都 fail-OPEN
    // （handlePreTool 直接 bail，控制面保护 / signal 拦截 / context 统计全部不生效）。
    // 而落点必须能搬出仓库：嵌在仓库内会让 TS 把主树 `node_modules/@types` 也收进编译，
    // 同一个包出现两份类型身份，worktree 里的 typecheck 因此必然报错。
    it('worktree 落在仓库外（monorepo 布局）→ 仍上溯到主仓 flow', async () => {
      const gitRoot = makeTmp();
      gitInit(gitRoot);
      const anchor = join(gitRoot, 'packages', 'app');
      mkdirSync(anchor, { recursive: true });
      writeFlowAt(anchor, true);
      writeFileSync(join(gitRoot, '.gitignore'), '**/.ai-flow/**/state/\n');
      writeFileSync(join(gitRoot, 'seed.txt'), 'x');
      execFileSync('git', ['add', '-A'], { cwd: gitRoot });
      execFileSync('git', ['commit', '-qm', 'base'], { cwd: gitRoot });

      const outside = join(makeTmp(), 'lanes', 'f1-R1');   // 与 gitRoot 无祖先关系
      execFileSync('git', ['worktree', 'add', '-q', outside, '-b', 'wt/f1-R1'], { cwd: gitRoot });
      const wtAnchor = join(outside, 'packages', 'app');
      expect(existsSync(join(wtAnchor, '.ai-flow'))).toBe(true);
      expect(existsSync(join(wtAnchor, '.ai-flow', 'parent-flow', 'state', 'active.json'))).toBe(false);

      const result = await hasActiveFlow(wtAnchor);
      expect(result).not.toBeNull();
      expect(result!.flowName).toBe('parent-flow');
      expect(realpathSync(result!.repoRoot)).toBe(realpathSync(anchor));

      execFileSync('git', ['worktree', 'remove', '--force', outside], { cwd: gitRoot });
    });

    // flow 自己的检出**本身就是一条 linked worktree** 时（main → W 里跑 flow → 从 W 再给
    // 票开树 T）。`--git-common-dir` 报的是**最外层**的 main，所以原先「映射回主检出」
    // 一步跳到 main —— 那里有一份被追踪的 `.ai-flow` 却没有 active.json，而空闲判决被当成
    // 终局，于是返回 null。null 是 fail-OPEN：handlePreTool 直接 bail，票树里子代理的控制面
    // 保护 / signal 拦截 / context 统计全部消失。开发者真实仓库正是这个拓扑。
    it('flow 所在检出本身是 linked worktree → 票树里仍解析到它（不被最外层主检出的空闲判决截断）', async () => {
      const main = makeTmp();
      gitInit(main);
      writeFlowAt(main, false);                         // `.ai-flow/<flow>/config.json` 是被追踪的
      writeFileSync(join(main, '.gitignore'), '**/.ai-flow/**/state/\n');
      execFileSync('git', ['add', '-A'], { cwd: main });
      execFileSync('git', ['commit', '-qm', 'base'], { cwd: main });

      // W：flow 真正跑在这里。active.json 落在被 gitignore 的 state/ 里，所以它只属于 W。
      const w = join(makeTmp(), 'checkouts', 'w');
      execFileSync('git', ['worktree', 'add', '-q', w, '-b', 'branch-w'], { cwd: main });
      // `state/` 被 gitignore → checkout 不会带过来，要自己建。这正是「W 里那份 active.json
      // 只可能是 W 自己起的」的证明。
      mkdirSync(join(w, '.ai-flow', 'parent-flow', 'state'), { recursive: true });
      writeFileSync(
        join(w, '.ai-flow', 'parent-flow', 'state', 'active.json'),
        JSON.stringify(makeActiveState({ flow_name: 'parent-flow' }))
      );
      expect(existsSync(join(main, '.ai-flow', 'parent-flow', 'state', 'active.json'))).toBe(false);

      // T：从 W 给某票开的树。git 把它登记在 main 的 common dir 下，所以从 T 问
      // `--git-common-dir` 得到的是 main 而不是 W —— 这正是原先解错的地方。
      const t = join(makeTmp(), 'lanes', 'f1-R1');
      execFileSync('git', ['worktree', 'add', '-q', t, '-b', 'wt/f1-R1'], { cwd: w });

      const result = await hasActiveFlow(t);
      expect(result).not.toBeNull();
      expect(result!.flowName).toBe('parent-flow');
      expect(realpathSync(result!.repoRoot)).toBe(realpathSync(w));

      execFileSync('git', ['worktree', 'remove', '--force', t], { cwd: main });
      execFileSync('git', ['worktree', 'remove', '--force', w], { cwd: main });
    });

    // 反向：所有检出的同名锚点都空闲时，判决仍是 null。放宽成「继续上溯」会让子项目锚点
    // 解析到仓库根那个无关的 flow —— 那正是「空闲就是空闲」这条规则要防的越权。
    it('所有检出的同名锚点都空闲 → 仍返回 null，不上溯到父项目的 flow', async () => {
      const gitRoot = makeTmp();
      gitInit(gitRoot);
      writeFlowAt(gitRoot, true);                       // 仓库根：有 active flow
      const anchor = join(gitRoot, 'packages', 'app');
      mkdirSync(anchor, { recursive: true });
      writeFlowAt(anchor, false);                       // 子项目锚点：空闲
      writeFileSync(join(gitRoot, '.gitignore'), '**/.ai-flow/**/state/\n');
      execFileSync('git', ['add', '-A'], { cwd: gitRoot });
      execFileSync('git', ['commit', '-qm', 'base'], { cwd: gitRoot });

      const outside = join(makeTmp(), 'lanes', 'f1-R1');
      execFileSync('git', ['worktree', 'add', '-q', outside, '-b', 'wt/f1-R1'], { cwd: gitRoot });
      const wtAnchor = join(outside, 'packages', 'app');

      expect(await hasActiveFlow(wtAnchor)).toBeNull();
      execFileSync('git', ['worktree', 'remove', '--force', outside], { cwd: gitRoot });
    });

    // worktree 里**自己**起了一个 flow 时，必须解析到它自己那份，不能被「映射回主检出」
    // 抢走。这是另一种并行形态的前提：把一个大需求拆成几块几乎无关联的需求，每块在自己的
    // worktree 里跑一个独立 flow（各有顶层 session），而不是一个 flow 分几条车道。
    // `state/` 被 gitignore，所以 worktree 里的 active.json 天然是它自己的、不会来自主检出。
    it('worktree 里有自己的 active flow → 用它自己那份，不映射回主检出', async () => {
      const gitRoot = makeTmp();
      gitInit(gitRoot);
      writeFlowAt(gitRoot, true);                       // 主检出：parent-flow 在跑
      writeFileSync(join(gitRoot, '.gitignore'), '**/.ai-flow/**/state/\n');
      execFileSync('git', ['add', '-A'], { cwd: gitRoot });
      execFileSync('git', ['commit', '-qm', 'base'], { cwd: gitRoot });

      const outside = join(makeTmp(), 'lanes', 'own-flow');
      execFileSync('git', ['worktree', 'add', '-q', outside, '-b', 'wt/own'], { cwd: gitRoot });
      // `state/` 被 gitignore，所以 checkout 根本不会带它过来——这里要自己建，而这正是
      // 「worktree 里那份 active.json 只可能是它自己起的」的证明。
      expect(existsSync(join(outside, '.ai-flow', 'parent-flow', 'state'))).toBe(false);
      mkdirSync(join(outside, '.ai-flow', 'parent-flow', 'state'), { recursive: true });
      writeFileSync(
        join(outside, '.ai-flow', 'parent-flow', 'state', 'active.json'),
        JSON.stringify(makeActiveState({ flow_name: 'parent-flow', flow_id: 'own-slice' }))
      );

      const result = await hasActiveFlow(outside);
      expect(result).not.toBeNull();
      expect(result!.state.flow_id).toBe('own-slice');                    // 不是主检出那份
      expect(realpathSync(result!.repoRoot)).toBe(realpathSync(outside)); // 锚点就是它自己
      execFileSync('git', ['worktree', 'remove', '--force', outside], { cwd: gitRoot });
    });

    // 跨检出解析必须**自报**，因为它是唯一会落到「别的检出」的路由。实测事故：开发者手建
    // 两条 worktree 当两条独立开发线（分支互不相同），A 里跑着一个 flow，于是在 B 里什么
    // flow 都起不来——B 被判成 A 那个 flow 的非 owner、整个 session 只读，而所有提示都说
    // 「当前工程已在进行流程」，读起来像 B 自己在跑流程；`start` 的拒绝还建议 `<flow> abort`，
    // 在 B 里执行会销毁 A 的流程状态。定位花了一整个 session。
    //
    // ⚠️ 标记不改解析宽度：收紧它（比如只认落在 `<repo>.ai-flow-worktrees/` 下的目录）会让
    // 用别的落点名的票树里的子代理 fail-OPEN，而本 describe 上面那几个用例正是为那类事故写的、
    // 全部刻意用任意落点名。改的是拿到结果的调用方——能不能说清「flow 在哪个检出」、能不能
    // 拦住作用在错误检出上的命令。
    it('跨检出解析到的 flow 带 viaSibling 标记（两条独立开发线互锁的那个形态）', async () => {
      const main = makeTmp();
      gitInit(main);
      writeFlowAt(main, false);                    // 主检出：只有被追踪的 config，没有活跃 flow
      writeFileSync(join(main, '.gitignore'), '**/.ai-flow/**/state/\n');
      execFileSync('git', ['add', '-A'], { cwd: main });
      execFileSync('git', ['commit', '-qm', 'base'], { cwd: main });

      // A：开发者手建的第一条开发线，flow 跑在这里。
      const a = join(makeTmp(), 'checkouts', 'a');
      execFileSync('git', ['worktree', 'add', '-q', a, '-b', 'feat/line-a'], { cwd: main });
      mkdirSync(join(a, '.ai-flow', 'parent-flow', 'state'), { recursive: true });
      writeFileSync(
        join(a, '.ai-flow', 'parent-flow', 'state', 'active.json'),
        JSON.stringify(makeActiveState({ flow_name: 'parent-flow', flow_id: 'line-a-flow' }))
      );

      // B：另一条独立开发线——分支不同、工作区独立、没有自己的 flow。
      const b = join(makeTmp(), 'checkouts', 'b');
      execFileSync('git', ['worktree', 'add', '-q', b, '-b', 'feat/line-b'], { cwd: main });

      const result = await hasActiveFlow(b);
      expect(result).not.toBeNull();
      expect(result!.state.flow_id).toBe('line-a-flow');            // 确实解析到了 A 的 flow
      expect(realpathSync(result!.repoRoot)).toBe(realpathSync(a));
      expect(result!.viaSibling).toBe(true);                        // 且自报「这是跨检出来的」

      execFileSync('git', ['worktree', 'remove', '--force', a], { cwd: main });
      execFileSync('git', ['worktree', 'remove', '--force', b], { cwd: main });
    });

    // 反面：worktree 里有自己的 active.json 时是**同检出**命中，不能带标记——否则调用方
    // 会把一个完全正常的「在自己检出里跑 flow」当成跨检出误锁去拦。
    it('worktree 里有自己的 flow → 同检出命中，不带 viaSibling', async () => {
      const gitRoot = makeTmp();
      gitInit(gitRoot);
      writeFlowAt(gitRoot, true);
      writeFileSync(join(gitRoot, '.gitignore'), '**/.ai-flow/**/state/\n');
      execFileSync('git', ['add', '-A'], { cwd: gitRoot });
      execFileSync('git', ['commit', '-qm', 'base'], { cwd: gitRoot });

      const own = join(makeTmp(), 'checkouts', 'own');
      execFileSync('git', ['worktree', 'add', '-q', own, '-b', 'wt/own'], { cwd: gitRoot });
      mkdirSync(join(own, '.ai-flow', 'parent-flow', 'state'), { recursive: true });
      writeFileSync(
        join(own, '.ai-flow', 'parent-flow', 'state', 'active.json'),
        JSON.stringify(makeActiveState({ flow_name: 'parent-flow', flow_id: 'its-own' }))
      );

      const result = await hasActiveFlow(own);
      expect(result!.state.flow_id).toBe('its-own');
      expect(result!.viaSibling).toBeUndefined();

      execFileSync('git', ['worktree', 'remove', '--force', own], { cwd: gitRoot });
    });

    // 同一条路径的 fail-closed 边界：worktree 外、主仓那侧锚点是**空闲**的（没有
    // active.json）时必须仍然返回 null，别因为「在 worktree 里」就放宽成解析父项目的 flow。
    it('worktree 落在仓库外、主仓对应锚点空闲 → null', async () => {
      const gitRoot = makeTmp();
      gitInit(gitRoot);
      writeFlowAt(gitRoot, true);                       // 顶层有 flow
      const anchor = join(gitRoot, 'packages', 'app');
      mkdirSync(anchor, { recursive: true });
      writeFlowAt(anchor, false);                       // 子项目锚点空闲
      writeFileSync(join(gitRoot, '.gitignore'), '**/.ai-flow/**/state/\n');
      execFileSync('git', ['add', '-A'], { cwd: gitRoot });
      execFileSync('git', ['commit', '-qm', 'base'], { cwd: gitRoot });

      const outside = join(makeTmp(), 'lanes', 'f1-R2');
      execFileSync('git', ['worktree', 'add', '-q', outside, '-b', 'wt/f1-R2'], { cwd: gitRoot });
      expect(await hasActiveFlow(join(outside, 'packages', 'app'))).toBeNull();
      execFileSync('git', ['worktree', 'remove', '--force', outside], { cwd: gitRoot });
    });

    it('submodule 内的空闲锚点 → 仍然 null（它的 .git 也是文件，但不是 worktree）', async () => {
      const gitRoot = makeTmp();
      gitInit(gitRoot);
      writeFlowAt(gitRoot, true);
      const sub = join(gitRoot, 'vendor', 'sub');
      mkdirSync(sub, { recursive: true });
      gitInit(sub);                                   // 独立仓库，模拟 submodule 的检出形态
      writeFlowAt(sub, false);
      expect(await hasActiveFlow(sub)).toBeNull();
    });

    it('普通 monorepo 子项目的空闲锚点 → 仍然 null', async () => {
      const gitRoot = makeTmp();
      gitInit(gitRoot);
      writeFlowAt(gitRoot, true);
      const pkg = join(gitRoot, 'packages', 'app');
      mkdirSync(pkg, { recursive: true });
      writeFlowAt(pkg, false);
      expect(await hasActiveFlow(pkg)).toBeNull();
    });
  });
});

describe('readSignal / writeSignalFile / isGatePending', () => {
  it('readSignal returns null when no signal file', () => {
    const root = makeTmp();
    expect(readSignal(root, 'test-flow')).toBeNull();
  });

  it('writeSignalFile + readSignal roundtrip', () => {
    const root = makeTmp();
    writeSignalFile(root, 'test-flow', 'review');
    expect(readSignal(root, 'test-flow')).toBe('review');
  });

  it('isGatePending: signal == nextStage + gate=true → true', () => {
    // MINIMAL_CONFIG: work has no gate, review has gate: true
    // isGatePending for review stage + signal='flow-complete' (review is terminal)
    expect(isGatePending('flow-complete', MINIMAL_CONFIG, 'review')).toBe(true);
  });

  it('isGatePending: signal null → false', () => {
    expect(isGatePending(null, MINIMAL_CONFIG, 'review')).toBe(false);
  });

  it('isGatePending: signal wrong content → false', () => {
    expect(isGatePending('wrong', MINIMAL_CONFIG, 'review')).toBe(false);
  });

  it('isGatePending: stage has no gate → false', () => {
    // work stage has no gate
    expect(isGatePending('review', MINIMAL_CONFIG, 'work')).toBe(false);
  });

  // ── New signal protocol: AI writes 'done', hook computes the rest ──
  it('isGatePending: signal=done + gate stage → true', () => {
    expect(isGatePending('done', MINIMAL_CONFIG, 'review')).toBe(true);
  });

  it('isGatePending: signal=done + non-gate stage → false', () => {
    expect(isGatePending('done', MINIMAL_CONFIG, 'work')).toBe(false);
  });

  it('isGatePending: signal=done + non-terminal gate stage → true', () => {
    // GATED_CONFIG: work has gate=true and is non-terminal
    expect(isGatePending('done', GATED_CONFIG, 'work')).toBe(true);
  });

  it('isGatePending: old stage-id signal + gate stage → true (backward compat)', () => {
    // GATED_CONFIG: work→review, signal='review' is the old protocol
    expect(isGatePending('review', GATED_CONFIG, 'work')).toBe(true);
  });
});

describe('appendLog', () => {
  it('writes to flow.log with timestamp, flowName, full sessionId, and message', async () => {
    const root = makeTmp();
    mkdirSync(join(root, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    await appendLog(root, 'test-flow', 'my-full-session-id', 'STARTED flow_id=abc stage=work');
    const content = readFileSync(
      join(root, '.ai-flow', 'test-flow', 'state', 'flow.log'),
      'utf-8'
    );
    expect(content).toMatch(/\[test-flow\] \[session=my-full-session-id\] STARTED flow_id=abc stage=work/);
  });

  it('multiple calls accumulate in order in flow.log', async () => {
    const root = makeTmp();
    mkdirSync(join(root, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    await appendLog(root, 'test-flow', 'sess-1', 'event-A');
    await appendLog(root, 'test-flow', 'sess-1', 'event-B');
    await appendLog(root, 'test-flow', 'sess-1', 'event-C');
    const lines = readFileSync(
      join(root, '.ai-flow', 'test-flow', 'state', 'flow.log'),
      'utf-8'
    ).trim().split('\n');
    expect(lines[0]).toContain('event-A');
    expect(lines[1]).toContain('event-B');
    expect(lines[2]).toContain('event-C');
  });

  it('each line starts with ISO timestamp', async () => {
    const root = makeTmp();
    mkdirSync(join(root, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    await appendLog(root, 'test-flow', 'sess-1', 'TEST_EVENT');
    const content = readFileSync(
      join(root, '.ai-flow', 'test-flow', 'state', 'flow.log'),
      'utf-8'
    );
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
  });
});

describe('nextStage', () => {
  it('returns next stage id', () => {
    const result = nextStage(MINIMAL_CONFIG, 'work');
    expect(result).toBe('review');
  });

  it('returns null for last stage', () => {
    const result = nextStage(MINIMAL_CONFIG, 'review');
    expect(result).toBeNull();
  });
});
