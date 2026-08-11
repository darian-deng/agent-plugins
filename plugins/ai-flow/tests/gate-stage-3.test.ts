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

  it('分支回合、每票各有自己的实施 commit → 放行（merge commit 的存在不影响）', () => {
    const { repo, flowDir, base } = makeRepo();
    for (const [branch, file, subject] of [
      ['wt/T1', 'one.txt', 'feat(T1): impl one'],
      ['wt/T2', 'two.txt', 'feat(T2): impl two'],
    ] as const) {
      git(repo, 'checkout', '-q', '-b', branch, base);
      commit(repo, file, subject);
      git(repo, 'checkout', '-q', '-');
      git(repo, 'merge', '-q', '--no-ff', '-m', `Merge ${branch} into main`, branch);
    }
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

  it('一笔 commit 的 subject 顶两票 → 报争用，并提示 squash 回合这一支', () => {
    const { repo, flowDir, base } = makeRepo();
    commit(repo, 'x.txt', 'feat: squash T1 T2 work');
    writeTickets(repo);
    writeState(flowDir, base);
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('争用');
    expect(r.stderr).toContain('--squash');
  });
});
