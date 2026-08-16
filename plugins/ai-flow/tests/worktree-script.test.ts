import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, symlinkSync, lstatSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { execFileSync, spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const SCRIPT = join(PLUGIN_ROOT, '.ai-flow', 'grill-flow', 'scripts', 'worktree.cjs');

// 被测的全是与真实 git 拓扑和真实目录布局耦合的判断（worktree 根 ≠ 项目根、锁文件在哪一层、
// close 到底拆不拆树），mock 不掉——只能在一次性临时仓库上跑真脚本。
describe('grill-flow worktree.cjs', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) execFileSync('rm', ['-rf', d]);
    tmpDirs.length = 0;
  });

  function git(repo: string, ...args: string[]): string {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' });
  }

  /**
   * 建仓并把脚本铺到 `<repo>/<anchorRel>/.ai-flow/grill-flow/scripts/`。
   * anchorRel = '' 时锚点就是 git 根；非空时模拟 monorepo 子项目锚点（本插件自己的形态）。
   * rootLock / anchorLock 控制 `package-lock.json` 放哪一层——装依赖探测的全部输入。
   */
  function makeRepo(opts: { anchorRel: string; rootLock?: boolean; anchorLock?: boolean }): {
    repo: string;
    anchor: string;
    lanes: string;
  } {
    const repo = mkdtempSync(join(tmpdir(), 'ai-flow-worktree-test-'));
    tmpDirs.push(repo);
    // 落点在仓库同级，所以它不在 repo 里 —— 单独登记，否则每跑一次测试都留一份整仓 checkout。
    tmpDirs.push(repo + '.ai-flow-worktrees');
    const anchor = opts.anchorRel ? join(repo, opts.anchorRel) : repo;
    mkdirSync(join(anchor, '.ai-flow', 'grill-flow', 'scripts'), { recursive: true });
    mkdirSync(join(anchor, '.ai-flow', 'grill-flow', 'state'), { recursive: true });
    mkdirSync(join(anchor, 'src'), { recursive: true });
    copyFileSync(SCRIPT, join(anchor, '.ai-flow', 'grill-flow', 'scripts', 'worktree.cjs'));
    // 脚本拿「自己旁边有没有 state/active.json」判断它是不是主检出那一份（worktree 里有
    // 一份被 git 追踪的同名副本，跑错了会静默作用在错误的树上）。`state/` 被 gitignore，
    // 所以真实形态就是「主检出有、副本没有」——夹具照这个建。
    writeFileSync(
      join(anchor, '.ai-flow', 'grill-flow', 'state', 'active.json'),
      JSON.stringify({ flow_id: 'f1', stage: 'stage-3' })
    );
    // open 拒绝在 `.worktrees/` 没被忽略时开树，所以这条是所有用例的前提。
    // `**/.ai-flow/**/state/` 是引擎建 flow 时写进去的真实规则——它决定了「车道副本里没有
    // active.json」，而脚本正是靠这一点分辨自己是不是主检出那一份。忽略它就等于让夹具偏离
    // 真实形态、把那条断言测成恒真。
    writeFileSync(join(repo, '.gitignore'), '.worktrees/\nnode_modules/\n**/.ai-flow/**/state/\n');
    if (opts.rootLock) writeLockPair(repo, 'root');
    if (opts.anchorLock) writeLockPair(anchor, 'anchor');
    writeFileSync(join(anchor, 'src', 'a.txt'), 'a\n');
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    return { repo, anchor, lanes: repo + '.ai-flow-worktrees' };
  }

  function writeLockPair(dir: string, name: string): void {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }) + '\n');
    writeFileSync(
      join(dir, 'package-lock.json'),
      JSON.stringify({ name, lockfileVersion: 3, requires: true, packages: { '': { name } } }) + '\n'
    );
  }

  function run(anchor: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, [join(anchor, '.ai-flow', 'grill-flow', 'scripts', 'worktree.cjs'), ...args], {
      cwd: anchor,
      encoding: 'utf-8',
    });
    return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  // `lstatSync` 不跟随软链接；不存在时抛异常，这里收成 null 便于断言。
  function lstatSyncSafe(p: string): unknown | null {
    try { return lstatSync(p); } catch { return null; }
  }

  // 断言路径时只比后缀：macOS 的 tmpdir 会被 git 解成 /private/var/…，全路径比不了。
  function cwdLine(stdout: string): string {
    return /^\s*cwd:\s*(.+)$/m.exec(stdout)?.[1]?.trim() ?? '';
  }

  describe('装依赖的探测目录 = 执行目录', () => {
    // 回归：原版按「主树的 flow 锚点」探锁文件、却在「worktree 根」执行。锚点 = git 根时
    // 看不出问题，monorepo 子项目锚点下两者分叉，实测后果是 npm 沿父目录上溯找到主树的
    // package.json、把主树 node_modules 整个重装，而 worktree 里一个依赖都没装成。
    it('锁文件在 git 根（workspace 形态）→ 在 worktree 根装', () => {
      const { anchor } = makeRepo({ anchorRel: 'sub/proj', rootLock: true });
      const r = run(anchor, 'open', 'f1', 'R1', '--install', 'true');
      expect(r.stdout).toContain('装依赖:');
      expect(cwdLine(r.stdout)).toMatch(/\.ai-flow-worktrees\/f1-R1$/);
    });

    it('锁文件在锚点（子项目是独立包）→ 在 worktree 里的锚点目录装', () => {
      const { anchor } = makeRepo({ anchorRel: 'sub/proj', anchorLock: true });
      const r = run(anchor, 'open', 'f1', 'R1', '--install', 'true');
      expect(cwdLine(r.stdout)).toMatch(/\.ai-flow-worktrees\/f1-R1\/sub\/proj$/);
    });

    it('两层都有锁文件 → 就近取锚点那份', () => {
      const { anchor } = makeRepo({ anchorRel: 'sub/proj', rootLock: true, anchorLock: true });
      const r = run(anchor, 'open', 'f1', 'R1', '--install', 'true');
      expect(cwdLine(r.stdout)).toMatch(/\.ai-flow-worktrees\/f1-R1\/sub\/proj$/);
    });

    it('探测出的目录在 worktree 内部，不是主树', () => {
      const { repo, anchor } = makeRepo({ anchorRel: 'sub/proj', anchorLock: true });
      const cwd = cwdLine(run(anchor, 'open', 'f1', 'R1', '--install', 'true').stdout);
      expect(cwd).toContain('.ai-flow-worktrees/');
      expect(cwd.endsWith(join(repo, 'sub', 'proj'))).toBe(false);
    });

    it('锁文件形态决定命令：package-lock → npm ci', () => {
      const { anchor } = makeRepo({ anchorRel: 'sub/proj', rootLock: true });
      // `--install` 不传，让探测自己选命令；不断言退出码——这里受测的是选了什么命令、
      // 在哪儿跑，而不是本机 npm 能否装成。
      const r = run(anchor, 'open', 'f1', 'R1');
      expect(r.stdout).toContain('装依赖: npm ci');
      expect(cwdLine(r.stdout)).toMatch(/\.ai-flow-worktrees\/f1-R1$/);
    });
  });

  describe('派发路径', () => {
    // 回归：子代理拿 `<WT>/…` 和该票 `Touches` 拼绝对路径，而 Touches 的基准是 flow 锚点。
    // 给了 worktree 根，子代理会在整仓根凭空建出一层同名目录，而机器门⑥ 抓不到
    //（剥不掉锚点前缀的路径原样匹配 Touches，全绿）。
    it('子项目锚点：给出 <WT>（项目根）与 worktree 根两个路径', () => {
      const { anchor } = makeRepo({ anchorRel: 'sub/proj', anchorLock: true });
      const r = run(anchor, 'open', 'f1', 'T1', '--install', 'true');
      expect(r.stdout).toContain('<WT>');
      const wt = /<WT>[^：]*：(.+)/.exec(r.stdout)?.[1]?.trim() ?? '';
      expect(wt).toMatch(/\.ai-flow-worktrees\/f1-T1\/sub\/proj$/);
      expect(wt.endsWith('/')).toBe(false);   // 尾斜杠会让 `<WT>/src` 拼成双斜杠
    });

    it('锚点就是 git 根：只给一个路径（不制造多余分支）', () => {
      const { anchor } = makeRepo({ anchorRel: '', anchorLock: true });
      const r = run(anchor, 'open', 'f1', 'T1', '--install', 'true');
      expect(r.stdout).toContain('派发给子代理时给绝对路径');
      expect(r.stdout).not.toContain('<WT>');
    });
  });

  describe('名字形态', () => {
    it('收 T<n>（一票一树）与 R<n>（一组一车道）', () => {
      const { anchor } = makeRepo({ anchorRel: '', anchorLock: true });
      expect(run(anchor, 'open', 'f1', 'T7', '--install', 'true').code).toBe(0);
      expect(run(anchor, 'open', 'f1', 'R2', '--install', 'true').code).toBe(0);
    });

    // 名字进 worktree 路径与分支名，而机器门⑤ 按 `.worktrees/<flow_id>-` 前缀查残留——
    // 放宽成任意字符串会让残留查不出来。
    it('拒绝其它形态', () => {
      const { anchor } = makeRepo({ anchorRel: '', anchorLock: true });
      for (const bad of ['X1', 'lane1', 'T', 'R1a']) {
        const r = run(anchor, 'open', 'f1', bad, '--install', 'true');
        expect(r.code).toBe(1);
        expect(r.stderr).toContain('名字应形如');
      }
    });
  });

  // schedule.cjs 把「执行单位」从主观判据变成算出来的两个数字。它不碰 git，只读 tickets.md。
  describe('schedule.cjs（执行单位判定）', () => {
    function makeFlow(tickets: string, lanes = false): string {
      const root = mkdtempSync(join(tmpdir(), 'ai-flow-sched-test-'));
      tmpDirs.push(root);
      const flowDir = join(root, '.ai-flow', 'grill-flow');
      mkdirSync(join(flowDir, 'scripts'), { recursive: true });
      mkdirSync(join(flowDir, 'state'), { recursive: true });
      mkdirSync(join(root, 'docs', 'grill-flows', 'f1'), { recursive: true });
      copyFileSync(
        join(PLUGIN_ROOT, '.ai-flow', 'grill-flow', 'scripts', 'schedule.cjs'),
        join(flowDir, 'scripts', 'schedule.cjs')
      );
      writeFileSync(join(flowDir, 'state', 'active.json'), JSON.stringify({ flow_id: 'f1' }));
      writeFileSync(join(root, 'docs', 'grill-flows', 'f1', 'tickets.md'), tickets);
      void lanes;
      return flowDir;
    }
    function runSched(flowDir: string): string {
      const r = spawnSync(process.execPath, [join(flowDir, 'scripts', 'schedule.cjs')], {
        cwd: flowDir,
        encoding: 'utf-8',
      });
      return (r.stdout ?? '') + (r.stderr ?? '');
    }

    // 写集全部相交 → 一票一树每轮只能做一票，放开上限也一样。这正是车道模式该赢的形状。
    it('写集全相交时，放开上限也不降轮数', () => {
      const t = ['T1', 'T2', 'T3', 'T4']
        .map((n) => `- [ ] ${n} x\n  - Blocked by: none\n  - Touches: src/shared.ts\n`)
        .join('');
      const out = runSched(makeFlow(t));
      expect(out).toContain('最长依赖链 1 票');
      expect(out).toMatch(/放开上限到 4（等于不限）→ 仍是 4 轮/);
      expect(out).toContain('瓶颈是**写集相交**');
    });

    // 写集互不相交且无依赖 → 一票一树一轮做完，车道模式反而慢，脚本必须推荐一票一树。
    it('写集互不相交时推荐一票一树', () => {
      const t = ['T1', 'T2', 'T3', 'T4']
        .map((n, i) => `- [ ] ${n} x\n  - Blocked by: none\n  - Touches: src/${i}/\n`)
        .join('');
      const out = runSched(makeFlow(t));
      expect(out).toContain('**一票一树**');
    });

    // 已落盘的 lane: 优先于自动分组——重入时必须算出同一个分组，不能重算。
    it('用票上已落盘的 lane: 算车道轮数', () => {
      const t =
        '- [ ] T1 a\n  - Blocked by: none\n  - Touches: src/a1.ts\n  - lane: R1\n' +
        '- [ ] T2 b\n  - Blocked by: none\n  - Touches: src/a2.ts\n  - lane: R1\n' +
        '- [ ] T3 c\n  - Blocked by: none\n  - Touches: src/b1.ts\n  - lane: R2\n';
      const out = runSched(makeFlow(t));
      expect(out).toContain('tickets.md 的 lane: 字段');
      expect(out).toMatch(/R1\(2\)/);
      // 两条车道里最长的是 2 票 → 2 轮；而这三票写集互不相交，一票一树 1 轮更快，
      // 所以这一条同时锁住「同一并发预算下对比」这个前提（否则会推荐车道）。
      expect(out).toMatch(/\*\*一票一树\*\*/);
    });

    it('Touches: none 的票只能独占一轮', () => {
      const t =
        '- [ ] T1 a\n  - Blocked by: none\n  - Touches: none\n' +
        '- [ ] T2 b\n  - Blocked by: none\n  - Touches: src/b.ts\n';
      const out = runSched(makeFlow(t));
      expect(out).toMatch(/放开上限到 2（等于不限）→ 仍是 2 轮/);
    });
  });

  describe('落点', () => {
    // 落点必须在仓库**外**。嵌在仓库内时 worktree 里的每个包都继承主树所有祖先目录的
    // `node_modules/@types`，TypeScript 因此把同一个包的两份类型身份一起收进编译，
    // worktree 里的 typecheck 报一堆「同名但不兼容」——与被测改动无关，却会卡住
    // pre-commit hook。实测过一次：落点在 `apps/desktop/.worktrees/` 时车道里 71 个错、
    // 主树 0 个错。
    it('建在仓库同级，不在仓库内', () => {
      const { repo, anchor, lanes } = makeRepo({ anchorRel: 'sub/proj', anchorLock: true });
      expect(run(anchor, 'open', 'f1', 'R1', '--install', 'true').code).toBe(0);
      expect(existsSync(join(lanes, 'f1-R1'))).toBe(true);
      expect(existsSync(join(anchor, '.worktrees', 'f1-R1'))).toBe(false);
      expect(join(lanes, 'f1-R1').startsWith(repo + '/')).toBe(false);
    });

    // 升级前开出去的树还在旧落点里跑着。认不出来就等于让它们永远收不了口，而报错会说
    // 「不存在，已收口过？」——方向完全指错。
    it('sync / close 仍认旧落点 `<锚点>/.worktrees/`', () => {
      const { repo, anchor } = makeRepo({ anchorRel: '', anchorLock: true });
      const legacy = join(repo, '.worktrees', 'f1-R9');
      git(repo, 'worktree', 'add', '-q', legacy, '-b', 'wt/f1-R9');
      writeFileSync(join(legacy, 'src', 'legacy.txt'), 'x\n');
      git(legacy, 'add', '-A');
      git(legacy, 'commit', '-q', '-m', 'feat(T9): legacy lane');

      expect(run(anchor, 'sync', 'f1', 'R9').code).toBe(0);
      const out = run(anchor, 'close', 'f1', 'R9');
      expect(out.code).toBe(0);
      expect(git(repo, 'log', '-1', '--format=%s')).toContain('T9');
      expect(existsSync(legacy)).toBe(false);
    });
  });

  describe('跑错脚本副本', () => {
    it('副本旁边没有 state/active.json → 拒绝运行，并指出正确那一份', () => {
      const { anchor, lanes } = makeRepo({ anchorRel: '', anchorLock: true });
      expect(run(anchor, 'open', 'f1', 'R1', '--install', 'true').code).toBe(0);
      // worktree 是整仓 checkout，`.ai-flow/` 被追踪 → 车道里有一份同名脚本副本，
      // 而 `state/` 被 gitignore、副本里没有。跑副本必须响亮拒绝而不是作用在错误的树上。
      const copy = join(lanes, 'f1-R1', '.ai-flow', 'grill-flow', 'scripts', 'worktree.cjs');
      expect(existsSync(copy)).toBe(true);
      const r = spawnSync(process.execPath, [copy, 'open', 'f1', 'R2'], {
        cwd: join(lanes, 'f1-R1'),
        encoding: 'utf-8',
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('不是主检出里那一份');
      // 静默建错树是这条断言要防的主要后果
      expect(existsSync(join(lanes, 'f1-R1') + '.ai-flow-worktrees')).toBe(false);
    });
  });

  describe('依赖漂移', () => {
    it('sync 把别的票改过的锁文件 rebase 进来 → 报出来并补装', () => {
      const { repo, anchor, lanes } = makeRepo({ anchorRel: '', anchorLock: true });
      expect(run(anchor, 'open', 'f1', 'R1', '--install', 'true').code).toBe(0);
      // 主分支上另一票改了锁文件（本 flow 实测最常见的形态：某票新增依赖）
      writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ name: 'anchor', lockfileVersion: 3, packages: { '': { name: 'anchor' }, 'node_modules/x': {} } }) + '\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'feat(T9): add dep');
      const r = run(anchor, 'sync', 'f1', 'R1', '--no-install');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('package-lock.json');
      expect(r.stdout).toContain('--no-install');
      expect(existsSync(join(lanes, 'f1-R1'))).toBe(true);
    });

    it('rebase 没带进依赖清单改动时不提装依赖', () => {
      const { repo, anchor } = makeRepo({ anchorRel: '', anchorLock: true });
      expect(run(anchor, 'open', 'f1', 'R1', '--install', 'true').code).toBe(0);
      writeFileSync(join(repo, 'src', 'other.txt'), 'other\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'feat(T9): code only');
      const r = run(anchor, 'sync', 'f1', 'R1');
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain('依赖清单变了');
    });

    it('close 把锁文件 ff 进主树 → 报出来（收口测试跑在主树上，它一样会陈旧）', () => {
      const { repo, anchor, lanes } = makeRepo({ anchorRel: '', anchorLock: true });
      expect(run(anchor, 'open', 'f1', 'R1', '--install', 'true').code).toBe(0);
      const wt = join(lanes, 'f1-R1');
      writeFileSync(join(wt, 'package-lock.json'), JSON.stringify({ name: 'anchor', lockfileVersion: 3, packages: { '': { name: 'anchor' }, 'node_modules/y': {} } }) + '\n');
      git(wt, 'add', '-A');
      git(wt, 'commit', '-q', '-m', 'feat(T1): add dep');
      const r = run(anchor, 'close', 'f1', 'R1', '--keep', '--no-install');
      expect(r.code).toBe(0);
      // ⚠️ 别断言 `package-lock.json`：`say(ff.out)` 会把 ff 的 diffstat 原样打出来，
      // 里面本来就有这个文件名——把依赖漂移整段删掉，那样的断言照样绿（实测过）。
      // 只断言产品代码独有的串。
      expect(r.stdout).toContain('本次回合带进');
      expect(r.stdout).toContain('依赖清单变了');
    });
  });

  describe('旧落点的兼容软链接', () => {
    // 它让仓内的全树扫描工具「在开发机恒红、在 CI 恒绿」（CI 的干净检出里没有它）。
    // ⚠️ 清理代码不能用 `existsSync` 前置判断：它**跟随**符号链接，而这一步跑在
    // `git worktree remove` 之后，此刻软链接已经悬挂 → existsSync 为 false，整段被跳过。
    it('末票 close 拆树后删掉旧路径上的悬挂软链接', () => {
      const { repo, anchor, lanes } = makeRepo({ anchorRel: '', anchorLock: true });
      expect(run(anchor, 'open', 'f1', 'R1', '--install', 'true').code).toBe(0);
      const wt = join(lanes, 'f1-R1');
      const legacy = join(repo, '.worktrees', 'f1-R1');
      mkdirSync(join(repo, '.worktrees'), { recursive: true });
      symlinkSync(wt, legacy);
      writeFileSync(join(wt, 'src', 'one.txt'), 'one\n');
      git(wt, 'add', '-A');
      git(wt, 'commit', '-q', '-m', 'feat(T1): one');

      const r = run(anchor, 'close', 'f1', 'R1');   // 不带 --keep = 末票，真拆
      expect(r.code).toBe(0);
      expect(existsSync(wt)).toBe(false);
      expect(lstatSyncSafe(legacy)).toBeNull();     // 软链接本身也没了
      expect(r.stdout).toContain('软链接');
    });

    it('旧路径是真目录时只警告、不删', () => {
      const { repo, anchor, lanes } = makeRepo({ anchorRel: '', anchorLock: true });
      expect(run(anchor, 'open', 'f1', 'R1', '--install', 'true').code).toBe(0);
      const legacy = join(repo, '.worktrees', 'f1-R1');
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, 'keep.txt'), 'x\n');
      const wt = join(lanes, 'f1-R1');
      writeFileSync(join(wt, 'src', 'one.txt'), 'one\n');
      git(wt, 'add', '-A');
      git(wt, 'commit', '-q', '-m', 'feat(T1): one');

      const r = run(anchor, 'close', 'f1', 'R1');
      expect(r.code).toBe(0);
      expect(existsSync(join(legacy, 'keep.txt'))).toBe(true);
      expect(r.stdout).toContain('还存在且');
      expect(r.stdout).toContain('本脚本不动它');
    });
  });

  describe('close 的 fail-closed 断言', () => {
    // 这三条原先写成「git 成功了才检查」，git 因任何理由失败（信号打断、输出溢出）时
    // 断言静默变成空操作、然后照常 ff。本脚本的自我定位是「前置断言」，查不了就不能放行。
    it('票分支不存在（rev-list 失败）→ 拒绝回合，不 ff', () => {
      const { repo, anchor } = makeRepo({ anchorRel: '', anchorLock: true });
      expect(run(anchor, 'open', 'f1', 'R1', '--install', 'true').code).toBe(0);
      const before = git(repo, 'rev-parse', 'HEAD').trim();
      git(repo, 'branch', '-M', 'wt/f1-R1', 'wt/renamed-away');
      const r = run(anchor, 'close', 'f1', 'R1', '--keep');
      expect(r.code).not.toBe(0);
      expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(before);   // 没有 ff
      // 断言的是**文案**而不只是退出码：fail-open 版本同样不会 ff（它会一路走到 ff 那步
      // 才失败），两者退出码一样。真正的差别是「哪一条断言在说话」——查不了就该就地拒绝，
      // 而不是让后面某一步碰巧兜住。
      expect(r.stderr).toContain('无法检查票分支上有没有 merge commit');
    });
  });

  describe('非 ASCII 记账文件名', () => {
    // 与已修掉的 `trim()` off-by-one 同形态：git 默认把非 ASCII 路径转义成 "docs/\347…"
    //（连引号一起），记账豁免前缀匹配不上 → 主树只有记账改动却被判成「子代理写错了地方」，
    // 从那一票起每次回合都被拒。
    it('主树只有中文名记账文件时照常回合', () => {
      const { repo, anchor, lanes } = makeRepo({ anchorRel: '', anchorLock: true });
      expect(run(anchor, 'open', 'f1', 'R1', '--install', 'true').code).toBe(0);
      const wt = join(lanes, 'f1-R1');
      writeFileSync(join(wt, 'src', 'one.txt'), 'one\n');
      git(wt, 'add', '-A');
      git(wt, 'commit', '-q', '-m', 'feat(T1): one');
      mkdirSync(join(repo, 'docs', 'grill-flows', 'f1'), { recursive: true });
      writeFileSync(join(repo, 'docs', 'grill-flows', 'f1', '真机验证清单.md'), '- T1\n');
      const r = run(anchor, 'close', 'f1', 'R1', '--keep');
      expect(r.code).toBe(0);
      expect(git(repo, 'log', '-1', '--format=%s')).toContain('T1');
    });
  });

  describe('close 的分支与不可逆保护', () => {
    it('主仓不在需求分支（切到了某条车道分支）→ 拒绝回合', () => {
      const { repo, anchor, lanes } = makeRepo({ anchorRel: '', anchorLock: true });
      expect(run(anchor, 'open', 'f1', 'R1', '--install', 'true').code).toBe(0);
      const wt = join(lanes, 'f1-R1');
      writeFileSync(join(wt, 'src', 'one.txt'), 'one\n');
      git(wt, 'add', '-A');
      git(wt, 'commit', '-q', '-m', 'feat(T1): one');
      git(repo, 'switch', '-q', '-c', 'wt/tmp-elsewhere');
      const r = run(anchor, 'close', 'f1', 'R1', '--keep');
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('车道分支');
    });

    it('ff 成功后打出不可逆横幅（close 不该串在验证命令后面）', () => {
      const { repo, anchor, lanes } = makeRepo({ anchorRel: '', anchorLock: true });
      expect(run(anchor, 'open', 'f1', 'R1', '--install', 'true').code).toBe(0);
      const wt = join(lanes, 'f1-R1');
      writeFileSync(join(wt, 'src', 'one.txt'), 'one\n');
      git(wt, 'add', '-A');
      git(wt, 'commit', '-q', '-m', 'feat(T1): one');
      const r = run(anchor, 'close', 'f1', 'R1', '--keep');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('不可逆');
      expect(git(repo, 'log', '-1', '--format=%s')).toContain('T1');
    });
  });

  describe('status', () => {
    it('列出本 flow 的车道并标出「不是 HEAD 后继」', () => {
      const { repo, anchor } = makeRepo({ anchorRel: '', anchorLock: true });
      expect(run(anchor, 'open', 'f1', 'R1', '--install', 'true').code).toBe(0);
      expect(run(anchor, 'open', 'f1', 'R2', '--install', 'true').code).toBe(0);
      // 主分支前进一步（模拟别的车道已回合）→ 两条车道都不再是 HEAD 的直接后继
      writeFileSync(join(repo, 'src', 'moved.txt'), 'moved\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'feat(T9): moved');
      const r = run(anchor, 'status', 'f1');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('R1');
      expect(r.stdout).toContain('R2');
      expect(r.stdout).toContain('NO(先 sync)');
    });

    // 「子代理停没停」不能问它自己：它停住时给主 session 发的通知与正常交付同样是
    // `completed`，只有正文有差别，而正文被读反过（实测「Waiting for the full web4 test
    // suite」被读成「它还在跑」，等了 1 小时 07 分）。工作树的物理变化是唯一的客观信号。
    it('报出每条车道的静默时长（停滞判据，不依赖子代理自我报告）', () => {
      const { anchor, lanes } = makeRepo({ anchorRel: '', anchorLock: true });
      expect(run(anchor, 'open', 'f1', 'R1', '--install', 'true').code).toBe(0);
      writeFileSync(join(lanes, 'f1-R1', 'src', 'wip.txt'), 'in progress\n');
      const r = run(anchor, 'status', 'f1');
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/静默:\d+分钟/);
      expect(r.stdout).toContain('静默 ≥30 分钟');   // 判据本身要印在输出里
    });
  });

  describe('close --keep（车道模式）', () => {
    function deliver(repo: string, wt: string, file: string, subject: string): void {
      writeFileSync(join(wt, file), subject + '\n');
      git(wt, 'add', '-A');
      git(wt, 'commit', '-q', '-m', subject);
      expect(git(repo, 'status', '--porcelain')).toBe('');   // close 要求主树只有记账改动
    }

    it('ff 回合后保留工作树与分支，同一棵树能继续做下一票', () => {
      const { repo, anchor, lanes } = makeRepo({ anchorRel: '', anchorLock: true });
      expect(run(anchor, 'open', 'f1', 'R1', '--install', 'true').code).toBe(0);
      const wt = join(lanes, 'f1-R1');

      deliver(repo, wt, 'src/one.txt', 'feat(T1): one');
      const keep = run(anchor, 'close', 'f1', 'R1', '--keep');
      expect(keep.code).toBe(0);
      expect(keep.stdout).toContain('--keep');
      expect(existsSync(wt)).toBe(true);
      expect(git(repo, 'log', '-1', '--format=%s')).toContain('T1');

      deliver(repo, wt, 'src/two.txt', 'feat(T2): two');
      const last = run(anchor, 'close', 'f1', 'R1');
      expect(last.code).toBe(0);
      expect(existsSync(wt)).toBe(false);   // 末票不带 --keep → 真拆，机器门⑤ 才能过
      expect(git(repo, 'log', '--format=%s', '-2')).toContain('T2');
      expect(git(repo, 'log', '--merges', '--format=%h', '-1')).toBe('');   // 历史线性
    });

    it('--keep 不跳过前置断言：工作树脏就拒绝回合', () => {
      const { repo, anchor, lanes } = makeRepo({ anchorRel: '', anchorLock: true });
      run(anchor, 'open', 'f1', 'R1', '--install', 'true');
      const wt = join(lanes, 'f1-R1');
      deliver(repo, wt, 'src/one.txt', 'feat(T1): one');
      writeFileSync(join(wt, 'src', 'stray.txt'), 'untracked\n');

      const r = run(anchor, 'close', 'f1', 'R1', '--keep');
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('未提交');
      expect(git(repo, 'log', '-1', '--format=%s')).toBe('base\n');   // 没回合
    });

    it('别的车道先回合过 → 本车道 close 报「不是直接后继」，sync 之后能回合', () => {
      const { repo, anchor, lanes } = makeRepo({ anchorRel: '', anchorLock: true });
      run(anchor, 'open', 'f1', 'R1', '--install', 'true');
      run(anchor, 'open', 'f1', 'R2', '--install', 'true');
      const wt1 = join(lanes, 'f1-R1');
      const wt2 = join(lanes, 'f1-R2');

      deliver(repo, wt1, 'src/lane1.txt', 'feat(T1): lane one');
      deliver(repo, wt2, 'src/lane2.txt', 'feat(T5): lane two');
      expect(run(anchor, 'close', 'f1', 'R1', '--keep').code).toBe(0);

      const blocked = run(anchor, 'close', 'f1', 'R2', '--keep');
      expect(blocked.code).toBe(1);
      expect(blocked.stderr).toContain('直接后继');

      expect(run(anchor, 'sync', 'f1', 'R2').code).toBe(0);
      expect(run(anchor, 'close', 'f1', 'R2', '--keep').code).toBe(0);
      expect(git(repo, 'log', '--merges', '--format=%h')).toBe('');
      expect(git(repo, 'log', '--format=%s', '-2')).toContain('T5');
    });

    // 回归：`git()` 曾对整段输出做 `trim()`，吃掉 `git status --porcelain` 首行那个表示
    // 「工作区已改、索引未改」的前导空格，于是按 `slice(3)` 取路径时首行错位一格
    // （`docs/…` 变成 `ocs/…`），记账豁免前缀匹配不上 —— stage-3 明文声明为正常状态的
    // 「主树只有 docs/grill-flows/ 下的记账改动」被判成「子代理把代码写进了主树」，
    // 从第二票起每次回合都被拒。第一票躲得过：那时记账文件还是未追踪的 `?? `。
    it('主树只有「已追踪、未暂存」的记账改动 → 照常回合（不误判成 stray）', () => {
      const { repo, anchor, lanes } = makeRepo({ anchorRel: '', anchorLock: true });
      const ledger = join(repo, 'docs', 'grill-flows', 'f1', 'tickets.md');
      mkdirSync(dirname(ledger), { recursive: true });
      writeFileSync(ledger, '- [ ] T1\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'docs: ledger');   // 先入库，之后的改动才是「已追踪未暂存」

      run(anchor, 'open', 'f1', 'R1', '--install', 'true');
      const wt = join(lanes, 'f1-R1');
      writeFileSync(join(wt, 'src', 'one.txt'), 'one\n');
      git(wt, 'add', '-A');
      git(wt, 'commit', '-q', '-m', 'feat(T1): one');

      writeFileSync(ledger, '- [x] T1\n  - qc:done\n');   // 记账：留工作树、不提交
      expect(git(repo, 'status', '--porcelain').startsWith(' M')).toBe(true);

      const out = run(anchor, 'close', 'f1', 'R1', '--keep');
      expect(out.stderr).not.toContain('非记账改动');
      expect(out.code).toBe(0);
      expect(git(repo, 'log', '-1', '--format=%s')).toContain('T1');
    });

    // 运行中升级插件（`/ai-flow:add` 的 install --force、或 scripts/upgrade-flows.cjs）会改写
    // 主树里被 git 跟踪的 `.ai-flow/<flow>/**`。那不能单独 commit——机器门③ 要求区间内每笔
    // commit 都归属某一票，一笔「升级 flow 定义」会 fail 掉整道门——所以只能留在工作树、
    // 由 stage-4 的 squash 吸收。close 若把它判成 stray，整条 flow 在升级之后就再也回合不了。
    it('主树有 .ai-flow/ 下的 flow 定义改动（运行中升级插件）→ 照常回合，不判成 stray', () => {
      const { repo, anchor, lanes } = makeRepo({ anchorRel: '', anchorLock: true });
      const def = join(repo, '.ai-flow', 'grill-flow', 'stages', 'stage-3.md');
      mkdirSync(dirname(def), { recursive: true });
      writeFileSync(def, 'old prompt\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'chore: flow def');

      run(anchor, 'open', 'f1', 'R1', '--install', 'true');
      deliver(repo, join(lanes, 'f1-R1'), 'src/one.txt', 'feat(T1): one');

      writeFileSync(def, 'upgraded prompt\n');                                   // 已追踪、被改写
      mkdirSync(join(repo, '.ai-flow', 'grill-flow', 'references'), { recursive: true });
      writeFileSync(join(repo, '.ai-flow', 'grill-flow', 'references', 'new.md'), 'x\n'); // 新增（未追踪）
      const out = run(anchor, 'close', 'f1', 'R1', '--keep');
      expect(out.stderr).not.toContain('非记账改动');
      expect(out.code).toBe(0);
    });

    it('.ai-flow/ 之外的代码 stray 仍然拦下（豁免没有放宽到全仓）', () => {
      const { repo, anchor, lanes } = makeRepo({ anchorRel: '', anchorLock: true });
      run(anchor, 'open', 'f1', 'R1', '--install', 'true');
      deliver(repo, join(lanes, 'f1-R1'), 'src/one.txt', 'feat(T1): one');
      writeFileSync(join(repo, 'src', 'leaked.txt'), 'leaked\n');
      const out = run(anchor, 'close', 'f1', 'R1', '--keep');
      expect(out.code).not.toBe(0);
      expect(out.stderr).toContain('非记账改动');
    });

    it('车道无独有 commit 时 sync 幂等', () => {
      const { repo, anchor, lanes } = makeRepo({ anchorRel: '', anchorLock: true });
      run(anchor, 'open', 'f1', 'R1', '--install', 'true');
      deliver(repo, join(lanes, 'f1-R1'), 'src/one.txt', 'feat(T1): one');
      run(anchor, 'close', 'f1', 'R1', '--keep');
      const r = run(anchor, 'sync', 'f1', 'R1');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('无需 rebase');
    });
  });
});
