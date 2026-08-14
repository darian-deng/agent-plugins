import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from 'fs';
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
    mkdirSync(join(anchor, 'src'), { recursive: true });
    copyFileSync(SCRIPT, join(anchor, '.ai-flow', 'grill-flow', 'scripts', 'worktree.cjs'));
    // open 拒绝在 `.worktrees/` 没被忽略时开树，所以这条是所有用例的前提。
    writeFileSync(join(repo, '.gitignore'), '.worktrees/\nnode_modules/\n');
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
