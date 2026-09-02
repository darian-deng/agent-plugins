import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { execFileSync, spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const GATE = join(PLUGIN_ROOT, '.ai-flow', 'grill-flow', 'scripts', 'gate-stage-3.cjs');

// 门在真实 git 历史上判 ticket↔commit，所以只能用一次性临时仓库测，不能 mock git：
// 被测的正是「哪些 commit 算证据」这条与 git 拓扑（父数）耦合的判据。
describe('grill-flow gate-stage-3.cjs — ticket↔commit 配对', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) execFileSync('rm', ['-rf', d]);
    tmpDirs.length = 0;
  });

  function git(repo: string, ...args: string[]): string {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' });
  }

  /** 建仓 + 铺出门要求的目录结构（flowDir = <repo>/.ai-flow/grill-flow），返回 base sha。 */
  function makeRepo(): { repo: string; flowDir: string; base: string } {
    const repo = mkdtempSync(join(tmpdir(), 'ai-flow-gate3-test-'));
    tmpDirs.push(repo);
    const flowDir = join(repo, '.ai-flow', 'grill-flow');
    mkdirSync(join(flowDir, 'scripts'), { recursive: true });
    mkdirSync(join(flowDir, 'state'), { recursive: true });
    mkdirSync(join(repo, 'docs', 'grill-flows', 'f1'), { recursive: true });
    copyFileSync(GATE, join(flowDir, 'scripts', 'gate-stage-3.cjs'));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    commit(repo, 'base.txt', 'base');
    return { repo, flowDir, base: git(repo, 'rev-parse', 'HEAD').trim() };
  }

  function commit(repo: string, file: string, subject: string): void {
    writeFileSync(join(repo, file), subject + '\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', subject);
  }

  /** 两票都已勾且都写了 qc:done —— 断言 ①② 满足，只留 ③ 受测。 */
  function writeTickets(repo: string): void {
    writeFileSync(
      join(repo, 'docs', 'grill-flows', 'f1', 'tickets.md'),
      '# tickets\n\n- [x] T1 — impl one\n  - qc:done\n- [x] T2 — impl two\n  - qc:done\n'
    );
  }

  function writeState(flowDir: string, base: string): void {
    writeFileSync(
      join(flowDir, 'state', 'active.json'),
      JSON.stringify({ flow_id: 'f1', base_sha_code: base })
    );
  }

  function runGate(flowDir: string): { code: number; stderr: string } {
    const r = spawnSync(process.execPath, [join(flowDir, 'scripts', 'gate-stage-3.cjs')], {
      cwd: flowDir,
      encoding: 'utf-8',
    });
    return { code: r.status ?? -1, stderr: r.stderr };
  }

  it('串行两笔 commit（每票 subject 含自己票号）→ 放行', () => {
    const { repo, flowDir, base } = makeRepo();
    commit(repo, 'one.txt', 'feat(T1): impl one');
    commit(repo, 'two.txt', 'feat(T2): impl two');
    writeTickets(repo);
    writeState(flowDir, base);
    expect(runGate(flowDir).code).toBe(0);
  });

  // cm:done（注释清理已做）是警告级、不阻断，且只在「这个 flow 已经在用它」时才说话——
  // 注释清理是后来从质量链子代理上收给主 session 的，那之前收口的票面没有这个字段。
  it('全部已勾票都没有 cm:done → 不警告（上收之前的 flow，报了就是噪音）', () => {
    const { repo, flowDir, base } = makeRepo();
    commit(repo, 'one.txt', 'feat(T1): impl one');
    commit(repo, 'two.txt', 'feat(T2): impl two');
    writeTickets(repo); // 两票都只有 qc:done
    writeState(flowDir, base);
    const r = runGate(flowDir);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain('cm:done');
  });

  it('一票有 cm:done 一票没有 → 放行但点名那张漏的', () => {
    const { repo, flowDir, base } = makeRepo();
    commit(repo, 'one.txt', 'feat(T1): impl one');
    commit(repo, 'two.txt', 'feat(T2): impl two');
    writeFileSync(
      join(repo, 'docs', 'grill-flows', 'f1', 'tickets.md'),
      '# tickets\n\n- [x] T1 — impl one\n  - qc:done\n  - cm:done\n- [x] T2 — impl two\n  - qc:done\n'
    );
    writeState(flowDir, base);
    const r = runGate(flowDir);
    expect(r.code).toBe(0);          // 警告级，不阻断
    // 只看 cm:done 那一行：这份 fixture 的票没有 Touches 声明，stderr 里还有断言⑥ 跳过
    // 该票的警告，那些行提到 T1/T2 与本条无关。
    const cmLine = r.stderr.split('\n').find((l) => l.includes('cm:done')) ?? '';
    expect(cmLine).toContain('T2');
    expect(cmLine).not.toContain('T1');
  });

  // 并行票的正常回合路径：子代理在自己分支上 commit、rebase 适配，主 session ff-only 回合。
  // 历史保持线性，所以断言 ③ 与 ④ 同时满足。
  it('分支 ff-only 回合、每票各有自己的实施 commit → 放行', () => {
    const { repo, flowDir, base } = makeRepo();
    for (const [branch, file, subject] of [
      ['wt/f1-T1', 'one.txt', 'feat(T1): impl one'],
      ['wt/f1-T2', 'two.txt', 'feat(T2): impl two'],
    ] as const) {
      git(repo, 'checkout', '-q', '-b', branch);
      commit(repo, file, subject);
      git(repo, 'checkout', '-q', '-');
      git(repo, 'merge', '-q', '--ff-only', branch);
    }
    writeTickets(repo);
    writeState(flowDir, base);
    expect(runGate(flowDir).code).toBe(0);
  });

  // 回归锚（断言 ④）：`-X ours` 在无文本冲突时静默丢弃一侧改动，而该票那笔 commit 仍在
  // 区间里，于是 ③ 照样绿、代码却不在树里。③ 与 /clear 重入判据都用 `--no-merges`，对
  // merge commit 的内容完全盲，`merge-base --is-ancestor` 也挡不住（ancestry 是拓扑属性）。
  // 唯一的物理防线是"历史必须线性"：任何非 ff 合并都必然留下 merge commit。
  it('用 -X ours 回合导致内容被丢弃 → 断言 ④ 拦下（③ 对它是盲的）', () => {
    const { repo, flowDir, base } = makeRepo();
    commit(repo, 'shared.txt', 'feat(T1): impl one');          // T1 改 shared
    git(repo, 'checkout', '-q', '-b', 'wt/f1-T2', base);
    commit(repo, 'shared.txt', 'feat(T2): impl two');          // T2 也改 shared，同一行
    git(repo, 'checkout', '-q', '-');
    git(repo, 'merge', '-q', '-X', 'ours', '-m', 'Merge wt/f1-T2', 'wt/f1-T2');
    // T2 的改动已被丢弃，但 subject 含 T2 的那笔 commit 仍在 base..HEAD --no-merges 里
    expect(git(repo, 'log', '--format=%s', '--no-merges', `${base}..HEAD`)).toContain('T2');
    expect(git(repo, 'show', 'HEAD:shared.txt')).toContain('T1');
    writeTickets(repo);
    writeState(flowDir, base);
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('merge commit');
    expect(r.stderr).toContain('--ff-only');
  });

  it('.worktrees/ 下有残留 worktree → 断言 ⑤ 拦下', () => {
    const { repo, flowDir, base } = makeRepo();
    commit(repo, 'one.txt', 'feat(T1): impl one');
    commit(repo, 'two.txt', 'feat(T2): impl two');
    git(repo, 'worktree', 'add', '-q', join(repo, '.worktrees', 'f1-T9'), '-b', 'wt/f1-T9');
    writeTickets(repo);
    writeState(flowDir, base);
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('未收口的 worktree');
  });

  // stage-3 第 6 步「收口测试失败」给的那两条命令必须能在无人值守下跑完，并且跑完之后
  // 机器门③④ 要过（修复被吸收进它所属的票、没有多出不归属任何票的 commit、历史线性）。
  // 这条同时锁住 --autostash 的必要性：stage-3 期间主树一直有**已追踪且未暂存**的记账改动，
  // 少了 --autostash 时 rebase 直接拒绝，而按它的报错去提交记账就会造出一笔 orphan commit。
  it('文档给的非交互 squash 流程：收口修复被吸收进它所属的票，机器门通过', () => {
    const { repo, flowDir } = makeRepo();
    // 记账文件在 base 之前入库，之后对它的修改才是「已追踪、未暂存」
    writeTickets(repo);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'docs: stage1-2 outputs');
    const base = git(repo, 'rev-parse', 'HEAD').trim();

    commit(repo, 'one.txt', 'feat(T1): impl one');
    const t1 = git(repo, 'rev-parse', 'HEAD').trim();
    commit(repo, 'two.txt', 'feat(T2): impl two');

    // 收口测试失败 → 在主树修 → 标成 fixup（不写票号，否则与该票争用配对）
    writeFileSync(join(repo, 'one.txt'), 'impl one\nfixed by batch closeout\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', `--fixup=${t1}`);
    // 记账：留工作树、不提交（这是 rebase 会拒绝的那种脏）。内容必须与已入库那份不同，
    // 否则 git 认为无改动、工作树是干净的，这条用例就测不到 --autostash 了。
    writeFileSync(join(repo, 'docs', 'grill-flows', 'f1', 'tickets.md'),
      '# tickets\n\n- [x] T1 — impl one\n  - qc:done\n  - lane: R1\n- [x] T2 — impl two\n  - qc:done\n  - lane: R1\n');
    expect(git(repo, 'status', '--porcelain').startsWith(' M')).toBe(true);

    // 文档给的第二条命令，原样
    execFileSync('git', ['-C', repo, 'rebase', '-i', '--autosquash', '--autostash', base], {
      env: { ...process.env, GIT_SEQUENCE_EDITOR: 'true' },
      encoding: 'utf-8',
    });

    // 修复进了 T1 那笔；区间里只有两笔、都归属某票；记账改动还在
    expect(git(repo, 'log', '--format=%s', `${base}..HEAD`).trim().split('\n')).toHaveLength(2);
    expect(git(repo, 'show', '--format=', '--name-only', 'HEAD~1')).toContain('one.txt');
    expect(git(repo, 'log', '--merges', '--format=%h', `${base}..HEAD`).trim()).toBe('');
    expect(git(repo, 'status', '--porcelain')).toContain('tickets.md');

    writeState(flowDir, base);
    expect(runGate(flowDir).code).toBe(0);
  });

  // 落点自 0.50.0 起在仓库**同级**（嵌在仓库内会让 worktree 里的 TS 收进主树的
  // `node_modules/@types`、同一个包两份类型身份）。⑤ 只查旧落点就会漏掉现在真正用的那个，
  // 而漏的方向是 fail-open：残留工作树带着没合回来的改动，门却放行。
  it('仓库同级落点下有残留 worktree → 断言 ⑤ 拦下', () => {
    const { repo, flowDir, base } = makeRepo();
    commit(repo, 'one.txt', 'feat(T1): impl one');
    commit(repo, 'two.txt', 'feat(T2): impl two');
    const lanes = repo + '.ai-flow-worktrees';
    tmpDirs.push(lanes);
    git(repo, 'worktree', 'add', '-q', join(lanes, 'f1-R1'), '-b', 'wt/f1-R1');
    writeTickets(repo);
    writeState(flowDir, base);
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('未收口的 worktree');
  });

  // 开发者常年挂着与本 flow 无关的 worktree；⑤ 若写成"除主工作树外为空"就会恒失败。
  it('仓库外的无关 worktree 不触发断言 ⑤', () => {
    const { repo, flowDir, base } = makeRepo();
    commit(repo, 'one.txt', 'feat(T1): impl one');
    commit(repo, 'two.txt', 'feat(T2): impl two');
    const outside = mkdtempSync(join(tmpdir(), 'ai-flow-unrelated-wt-'));
    tmpDirs.push(outside);
    git(repo, 'worktree', 'add', '-q', join(outside, 'dev'), '-b', 'unrelated-dev');
    writeTickets(repo);
    writeState(flowDir, base);
    expect(runGate(flowDir).code).toBe(0);
  });

  it('实际改动超出该票声明的 Touches → 断言 ⑥ 拦下；记账区不计入', () => {
    const { repo, flowDir, base } = makeRepo();
    // T1 只声明 src/one.ts，却顺带改了 src/stray.ts；同时改了记账区（应被忽略）
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'one.ts'), 'one\n');
    writeFileSync(join(repo, 'src', 'stray.ts'), 'stray\n');
    writeFileSync(join(repo, 'docs', 'grill-flows', 'f1', 'candidates.md'), 'c\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'feat(T1): impl one');
    writeFileSync(join(repo, 'src', 'two.ts'), 'two\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'feat(T2): impl two');
    writeFileSync(
      join(repo, 'docs', 'grill-flows', 'f1', 'tickets.md'),
      '# tickets\n\n- [x] T1 — impl one\n  Touches: src/one.ts\n  - qc:done\n' +
      '- [x] T2 — impl two\n  Touches: src/two.ts\n  - qc:done\n'
    );
    writeState(flowDir, base);
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('src/stray.ts');
    expect(r.stderr).not.toContain('candidates.md');   // 记账区被排除
  });

  it('Touches 用目录前缀 / glob 时正确放行', () => {
    const { repo, flowDir, base } = makeRepo();
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    mkdirSync(join(repo, 'tests'), { recursive: true });
    writeFileSync(join(repo, 'src', 'deep', 'a.ts'), 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'feat(T1): impl one');
    writeFileSync(join(repo, 'tests', 'x.test.ts'), 't\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'feat(T2): impl two');
    writeFileSync(
      join(repo, 'docs', 'grill-flows', 'f1', 'tickets.md'),
      '# tickets\n\n- [x] T1 — impl one\n  Touches: src/\n  - qc:done\n' +
      '- [x] T2 — impl two\n  Touches: tests/*.test.ts\n  - qc:done\n'
    );
    writeState(flowDir, base);
    expect(runGate(flowDir).code).toBe(0);
  });

  it('同一 batch 内两票改了同一文件 → 断言 ⑦ 拦下', () => {
    const { repo, flowDir, base } = makeRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'shared.ts'), 'v1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'feat(T1): impl one');
    writeFileSync(join(repo, 'src', 'shared.ts'), 'v1\nv2\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'feat(T2): impl two');
    writeFileSync(
      join(repo, 'docs', 'grill-flows', 'f1', 'tickets.md'),
      '# tickets\n\n- [x] T1 — impl one\n  Touches: src/\n  batch: B1\n  - qc:done\n' +
      '- [x] T2 — impl two\n  Touches: src/\n  batch: B1\n  - qc:done\n'
    );
    writeState(flowDir, base);
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('src/shared.ts');
    expect(r.stderr).toContain('batch B1');
  });

  // 回归锚：Kuhn 匹配只要求每票**至少**一笔，多出来的 commit 留在 owner=-1，而 ⑥⑦ 只看
  // 被配对的那一笔。于是越界改动落在"较老那笔"就能整个逃过 ⑥（落在最新那笔反而会被抓到，
  // 门因此还是不确定的）。要求区间内每笔都归属某一票，把这个逃逸口关掉。
  it('一票两笔 commit、越界改动落在没被配对的那笔 → 拦下', () => {
    const { repo, flowDir, base } = makeRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'secret'), { recursive: true });
    writeFileSync(join(repo, 'secret', 'leak.ts'), 'leak\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'feat(T1): part a');       // 越界文件在较老这笔
    writeFileSync(join(repo, 'src', 'a.ts'), 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'feat(T1): part b');       // 声明范围内的在较新这笔
    writeFileSync(join(repo, 'src', 'two.ts'), 'two\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'feat(T2): impl two');
    writeFileSync(
      join(repo, 'docs', 'grill-flows', 'f1', 'tickets.md'),
      '# tickets\n\n- [x] T1 — impl one\n  Touches: src/a.ts\n  - qc:done\n' +
      '- [x] T2 — impl two\n  Touches: src/two.ts\n  - qc:done\n'
    );
    writeState(flowDir, base);
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('不归属任何 ticket');
  });

  it('无票号的顺手 commit（改了未声明文件）→ 拦下', () => {
    const { repo, flowDir, base } = makeRepo();
    commit(repo, 'one.txt', 'feat(T1): impl one');
    commit(repo, 'two.txt', 'feat(T2): impl two');
    commit(repo, 'leak.txt', 'chore: drive-by edit');
    writeTickets(repo);
    writeState(flowDir, base);
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('不归属任何 ticket');
  });

  // 回归锚：`--no-renames` 关掉后旧新两条路径都报。默认只报新路径，于是一票把别票的文件
  // `git mv` 走时，旧路径的删除对 ⑥⑦ 不可见（写集相交被隐藏）。
  it('git mv 走别票的文件 → 旧路径可见、⑥ 拦下', () => {
    const { repo, flowDir } = makeRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'owned-by-t2.ts'), 'a'.repeat(200) + '\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'seed files');
    // seed 要并入 base：base 之后的每一笔都必须归属某一票（否则先撞 orphan 断言）。
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    git(repo, 'mv', 'src/owned-by-t2.ts', 'src/moved.ts');
    git(repo, 'commit', '-q', '-m', 'feat(T1): impl one');
    writeFileSync(join(repo, 'src', 'two.ts'), 'two\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'feat(T2): impl two');
    writeFileSync(
      join(repo, 'docs', 'grill-flows', 'f1', 'tickets.md'),
      '# tickets\n\n- [x] T1 — impl one\n  Touches: src/moved.ts\n  - qc:done\n' +
      '- [x] T2 — impl two\n  Touches: src/two.ts\n  - qc:done\n'
    );
    writeState(flowDir, base);
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('src/owned-by-t2.ts');
  });

  // 回归锚：默认 core.quotePath=true 会把非 ASCII 路径转义成 "src/\346\226\207…"，
  // 那种形态与任何 Touches glob 都匹配不上——含中日文文件名的项目会被 ⑥ 一进来就卡死。
  it('非 ASCII 路径不被 ⑥ 误报', () => {
    const { repo, flowDir, base } = makeRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', '文档.ts'), 'doc\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'feat(T1): impl one');
    writeFileSync(join(repo, 'src', 'two.ts'), 'two\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'feat(T2): impl two');
    writeFileSync(
      join(repo, 'docs', 'grill-flows', 'f1', 'tickets.md'),
      '# tickets\n\n- [x] T1 — impl one\n  Touches: src/\n  - qc:done\n' +
      '- [x] T2 — impl two\n  Touches: src/two.ts\n  - qc:done\n'
    );
    writeState(flowDir, base);
    expect(runGate(flowDir).code).toBe(0);
  });

  // 回归锚：`git show --name-only` 输出 git 根相对路径，而 Touches 是照锚点写的。
  // monorepo 子项目锚点（本插件自己就是）下两者不同 → ⑥ 全票误报、⑦ 因记账区判定失效而全相交。
  it('锚点是 monorepo 子项目时，⑥⑦ 的路径基准正确', () => {
    const outer = mkdtempSync(join(tmpdir(), 'ai-flow-gate3-mono-'));
    tmpDirs.push(outer);
    const repo = join(outer, 'packages', 'app');       // 锚点在子目录
    const flowDir = join(repo, '.ai-flow', 'grill-flow');
    mkdirSync(join(flowDir, 'scripts'), { recursive: true });
    mkdirSync(join(flowDir, 'state'), { recursive: true });
    mkdirSync(join(repo, 'docs', 'grill-flows', 'f1'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    copyFileSync(GATE, join(flowDir, 'scripts', 'gate-stage-3.cjs'));
    git(outer, 'init', '-q');
    git(outer, 'config', 'user.email', 'test@example.com');
    git(outer, 'config', 'user.name', 'test');
    writeFileSync(join(outer, 'root.txt'), 'root\n');
    git(outer, 'add', '-A');
    git(outer, 'commit', '-q', '-m', 'base');
    const base = git(outer, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(repo, 'src', 'a.ts'), 'a\n');
    git(outer, 'add', '-A');
    git(outer, 'commit', '-q', '-m', 'feat(T1): impl one');
    writeFileSync(join(repo, 'src', 'b.ts'), 'b\n');
    writeFileSync(join(repo, 'docs', 'grill-flows', 'f1', 'candidates.md'), 'c\n');
    git(outer, 'add', '-A');
    git(outer, 'commit', '-q', '-m', 'feat(T2): impl two');
    writeFileSync(
      join(repo, 'docs', 'grill-flows', 'f1', 'tickets.md'),
      '# tickets\n\n- [x] T1 — impl one\n  Touches: src/a.ts\n  batch: B1\n  - qc:done\n' +
      '- [x] T2 — impl two\n  Touches: src/b.ts\n  batch: B1\n  - qc:done\n'
    );
    writeState(flowDir, base);
    const r = runGate(flowDir);
    expect(r.stderr).toBe('');       // 锚点相对的 Touches 必须匹配上，记账区必须被剔除
    expect(r.code).toBe(0);
  });

  // 顶格写的 Touches 会被 ⑥ 跳过（只认缩进子行）。gate-stage-2 现在会拦这种写法，
  // 但这里仍要保证"跳过"不是静默的——门看着在把关、实际是空操作最危险。
  it('无可解析 Touches 时 ⑥ 跳过，但会打警告', () => {
    const { repo, flowDir, base } = makeRepo();
    commit(repo, 'anything.txt', 'feat(T1): impl one');
    commit(repo, 'whatever.txt', 'feat(T2): impl two');
    writeTickets(repo);
    writeState(flowDir, base);
    const r = runGate(flowDir);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('已跳过断言⑥');
  });

  // 回归锚：最大匹配不唯一时可以是「合法但对调」的解——两票各只改了自己声明的文件，
  // 配对却互换，于是⑥ 把两票都报成越界，且提示让你把对方的文件补进自己的 Touches
  // （照做后⑦ 接着报相交，死循环）。而且换个提交顺序同样的状态就通过了。
  // 要求 subject 只含本票号，配对就必然唯一。
  it('subject 含多个票号 → 拦下（否则配对不唯一、两票被互相误报越界）', () => {
    const { repo, flowDir, base } = makeRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'b.ts'), 'b\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'feat(T2): b — builds on T1');
    writeFileSync(join(repo, 'src', 'a.ts'), 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'feat(T1): a — unblocks T2');
    writeFileSync(
      join(repo, 'docs', 'grill-flows', 'f1', 'tickets.md'),
      '# tickets\n\n- [x] T1 — a\n  Touches: src/a.ts\n  - qc:done\n' +
      '- [x] T2 — b\n  Touches: src/b.ts\n  - qc:done\n'
    );
    writeState(flowDir, base);
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('多个票号');
  });

  // 回归锚：`--allow-empty` 的提交能过「有没有 commit」，也能过⑥⑦（空集不越界、
  // 与谁都不相交），最后落进 squash 的是零字节。
  it('空提交（--allow-empty）→ 拦下', () => {
    const { repo, flowDir, base } = makeRepo();
    commit(repo, 'one.txt', 'feat(T1): impl one');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'feat(T2): impl two');
    writeFileSync(
      join(repo, 'docs', 'grill-flows', 'f1', 'tickets.md'),
      '# tickets\n\n- [x] T1 — one\n  Touches: one.txt\n  - qc:done\n' +
      '- [x] T2 — two\n  Touches: two.txt\n  - qc:done\n'
    );
    writeState(flowDir, base);
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('没有代码交付');
  });

  // 回归锚：gate-stage-2 也拦重复票号，但那是切票阶段；这一层是独立的兜底，
  // 之前完全没有测试覆盖。
  it('tickets.md 重复票号 → 拦下', () => {
    const { repo, flowDir, base } = makeRepo();
    commit(repo, 'one.txt', 'feat(T1): impl one');
    commit(repo, 'two.txt', 'feat(T2): impl two');
    writeFileSync(
      join(repo, 'docs', 'grill-flows', 'f1', 'tickets.md'),
      '# tickets\n\n- [x] T1 — one\n  - qc:done\n- [x] T2 — two\n  - qc:done\n- [x] T1 — dup\n  - qc:done\n'
    );
    writeState(flowDir, base);
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('重复');
  });

  // ⑤ 只该管本 flow 自己开的 worktree（`<flow_id>-T<n>`）。开发者常年挂在
  // `.worktrees/dev` 的无关工作目录不能让这道门恒失败。
  it('.worktrees/ 下与本 flow 无关的 worktree 不触发 ⑤', () => {
    const { repo, flowDir, base } = makeRepo();
    commit(repo, 'one.txt', 'feat(T1): impl one');
    commit(repo, 'two.txt', 'feat(T2): impl two');
    git(repo, 'worktree', 'add', '-q', join(repo, '.worktrees', 'dev'), '-b', 'my-feature');
    writeTickets(repo);
    writeState(flowDir, base);
    expect(runGate(flowDir).code).toBe(0);
  });

  // 本次改动之前建立的 tickets.md 没有 Touches/batch 行——不能因此把老 flow 卡死。
  it('无 Touches / batch 的老 tickets.md → ⑥⑦ 跳过，放行', () => {
    const { repo, flowDir, base } = makeRepo();
    commit(repo, 'anything.txt', 'feat(T1): impl one');
    commit(repo, 'whatever.txt', 'feat(T2): impl two');
    writeTickets(repo);
    writeState(flowDir, base);
    expect(runGate(flowDir).code).toBe(0);
  });

  // 回归锚：分支名带票号时 git 自动生成的 merge subject（`Merge wt/T2 into …`）也含 `\bT2\b`，
  // 曾让一个从没写过任何实施 commit 的 ticket 满足断言 ③——门对"勾了 [x] 却没做"失去鉴别力。
  it('某票只有自动 merge commit、没有自己的实施 commit → 拦下', () => {
    const { repo, flowDir, base } = makeRepo();
    git(repo, 'checkout', '-q', '-b', 'wt/T1', base);
    commit(repo, 'one.txt', 'feat(T1): impl one');
    git(repo, 'checkout', '-q', '-');
    git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge wt/T1 into main', 'wt/T1');
    git(repo, 'checkout', '-q', '-b', 'wt/T2', base);
    commit(repo, 'two.txt', 'chore: wip no ticket number');
    git(repo, 'checkout', '-q', '-');
    git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge wt/T2 into main', 'wt/T2');
    writeTickets(repo);
    writeState(flowDir, base);
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('T2');
    expect(r.stderr).toContain('merge commit 也不算');
  });

  // 一笔 commit 不能顶两票。这个场景现在由「subject 含多个票号」那条断言拦下——它排在
  // 配对之前，诊断比事后报「争用」精确得多（争用的文案要让作者在三种可能里自己分辨）。
  it('一笔 commit 的 subject 顶两票 → 拦下', () => {
    const { repo, flowDir, base } = makeRepo();
    commit(repo, 'x.txt', 'feat: squash T1 T2 work');
    writeTickets(repo);
    writeState(flowDir, base);
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('多个票号');
    expect(r.stderr).toContain('T1 T2');
  });
});
