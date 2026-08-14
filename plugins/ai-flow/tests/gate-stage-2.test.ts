import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { execFileSync, spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const GATE = join(PLUGIN_ROOT, '.ai-flow', 'grill-flow', 'scripts', 'gate-stage-2.cjs');

// 这道门是 stage-3 并行调度的数据前提：`Blocked by` 要能被解析成依赖图（frontier 用它），
// `Touches` 要存在（批次准入用它判写集不相交）。所以校验强度本身需要回归锚。
describe('grill-flow gate-stage-2.cjs — 依赖图与写集声明', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) execFileSync('rm', ['-rf', d]);
    tmpDirs.length = 0;
  });

  function makeRepo(ticketsBody: string): string {
    const repo = mkdtempSync(join(tmpdir(), 'ai-flow-gate2-test-'));
    tmpDirs.push(repo);
    const flowDir = join(repo, '.ai-flow', 'grill-flow');
    const docs = join(repo, 'docs', 'grill-flows', 'f1');
    mkdirSync(join(flowDir, 'scripts'), { recursive: true });
    mkdirSync(join(flowDir, 'state'), { recursive: true });
    mkdirSync(docs, { recursive: true });
    copyFileSync(GATE, join(flowDir, 'scripts', 'gate-stage-2.cjs'));
    writeFileSync(join(flowDir, 'state', 'active.json'), JSON.stringify({ flow_id: 'f1' }));
    writeFileSync(
      join(docs, 'spec.md'),
      '## Problem\np\n## User Stories\n1. us\n## Testing Decisions\nseam\n## 方案审查\n已审查，无阻塞项\n'
    );
    writeFileSync(join(docs, 'tech-design.html'), '<html><body>ok</body></html>\n');
    writeFileSync(join(docs, 'tickets.md'), ticketsBody);
    return flowDir;
  }

  function runGate(flowDir: string): { code: number; stderr: string } {
    const r = spawnSync(process.execPath, [join(flowDir, 'scripts', 'gate-stage-2.cjs')], {
      cwd: flowDir,
      encoding: 'utf-8',
    });
    return { code: r.status ?? -1, stderr: r.stderr };
  }

  it('票号列表 + none + 有效引用 → 放行', () => {
    const flowDir = makeRepo(
      '- [ ] T1 first\n  Blocked by: none\n  Touches: src/a.ts\n' +
      '- [ ] T2 second\n  Blocked by: T1\n  Touches: src/b.ts tests/*.test.ts\n'
    );
    expect(runGate(flowDir).code).toBe(0);
  });

  it('缺 Touches → 拦下', () => {
    const flowDir = makeRepo('- [ ] T1 first\n  Blocked by: none\n');
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Touches');
  });

  it('缺 Blocked by → 拦下', () => {
    const flowDir = makeRepo('- [ ] T1 first\n  Touches: src/a.ts\n');
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Blocked by');
  });

  // 旧门只做 /Blocked by/i.test(block)，`TBD` 这类过得去——而 stage-3 要拿它算批次。
  it('Blocked by 写成散文 / TBD → 拦下', () => {
    const flowDir = makeRepo('- [ ] T1 first\n  Blocked by: TBD 等确认\n  Touches: src/a.ts\n');
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('不是票号列表');
  });

  it('引用不存在的票号 → 拦下', () => {
    const flowDir = makeRepo('- [ ] T1 first\n  Blocked by: T99\n  Touches: src/a.ts\n');
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('不存在的票号');
  });

  it('自依赖 → 拦下', () => {
    const flowDir = makeRepo('- [ ] T1 first\n  Blocked by: T1\n  Touches: src/a.ts\n');
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('自依赖');
  });

  // 环不会报错、只会让 frontier 空转（表现为"卡住"），所以必须在这道门拦。
  it('循环依赖 → 拦下并给出环路', () => {
    const flowDir = makeRepo(
      '- [ ] T1 a\n  Blocked by: T2\n  Touches: src/a.ts\n' +
      '- [ ] T2 b\n  Blocked by: T3\n  Touches: src/b.ts\n' +
      '- [ ] T3 c\n  Blocked by: T1\n  Touches: src/c.ts\n'
    );
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('循环依赖');
    expect(r.stderr).toContain('→');
  });

  it('none 的各种写法（无 / - / —）都接受', () => {
    for (const v of ['none', 'None', '无', '-', '—']) {
      const flowDir = makeRepo(`- [ ] T1 first\n  Blocked by: ${v}\n  Touches: src/a.ts\n`);
      expect(runGate(flowDir).code, `Blocked by: ${v}`).toBe(0);
    }
  });

  it('Touches: none 可接受（该票只能串行）', () => {
    const flowDir = makeRepo('- [ ] T1 first\n  Blocked by: none\n  Touches: none\n');
    expect(runGate(flowDir).code).toBe(0);
  });

  // 回归锚：两道门的块口径必须一致。gate-stage-3 只从**缩进**子行收集 Touches，
  // 顶格写的它拿不到 → 断言⑥ 对该票静默跳过。所以这里必须拦，不能放行。
  it('Touches 顶格（非缩进）→ 拦下', () => {
    const flowDir = makeRepo('- [ ] T1 first\n  Blocked by: none\nTouches: src/a.ts\n');
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('缩进');
  });

  // 回归锚：`Touches:` 后面空着能过存在性检查，而 gate-stage-3 要求有值，拿不到就跳过⑥。
  it('Touches 有键无值 → 拦下', () => {
    const flowDir = makeRepo('- [ ] T1 first\n  Blocked by: none\n  Touches:\n');
    expect(runGate(flowDir).code).toBe(1);
  });

  // 回归锚：无行锚的 /Blocked by:?…/ 会吃到 AC 里出现的「Blocked by」字样，
  // 把散文当票号列表报错，而真正那行写在它后面。
  it('AC 里提到 "Blocked by" 字样不影响真正那行的解析', () => {
    const flowDir = makeRepo(
      '- [ ] T1 first\n  - AC: 文档要说明 Blocked by 的含义是实施先后\n  Blocked by: none\n  Touches: src/a.ts\n'
    );
    expect(runGate(flowDir).code).toBe(0);
  });

  // 回归锚：deps 以票号为 key，重复票号会让后写覆盖先写，环检测因此失效。
  it('重复票号 → 拦下（否则环检测会被绕过）', () => {
    const flowDir = makeRepo(
      '- [ ] T1 a\n  Blocked by: T2\n  Touches: src/a.ts\n' +
      '- [ ] T2 b\n  Blocked by: T1\n  Touches: src/b.ts\n' +
      '- [ ] T1 a-dup\n  Blocked by: none\n  Touches: src/c.ts\n'
    );
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('重复');
  });

  // 回归锚：跨包票会自然写成 `../pkg/src/`，而 gate-stage-3 的 ⑥ 比的是路径字符串
  // （git 根相对剥掉锚点前缀），`..` 匹配不上任何实际改动 → 该票全部改动判越界，
  // 报错方向还是反的。锚点外的包只能写仓库根相对路径。
  it('Touches 用 `..` 上溯 → 拦下，且报的是上溯而不是尾斜杠', () => {
    for (const v of ['../net/src/', '..', 'src/../lib/']) {
      const flowDir = makeRepo(`- [ ] T1 first\n  Blocked by: none\n  Touches: ${v}\n`);
      const r = runGate(flowDir);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('`..` 上溯');
    }
  });

  it('Touches 写仓库根相对路径（锚点外的包）→ 放行', () => {
    const flowDir = makeRepo('- [ ] T1 first\n  Blocked by: none\n  Touches: packages/net/src/ src/a.ts\n');
    expect(runGate(flowDir).code).toBe(0);
  });

  // 目录漏尾斜杠会被 gate-stage-3 编译成 `^src/hooks$`、匹配零个文件，
  // 于是该票所有改动都判越界——误报方向，在这里就拦住并说清怎么写。
  it('Touches 目录漏尾斜杠 → 拦下', () => {
    const flowDir = makeRepo('- [ ] T1 first\n  Blocked by: none\n  Touches: srchooks\n');
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('/` 结尾');
  });

  // 回归锚：`src/lib` 这种真实的漏尾斜杠写法有斜杠，只查「不含 /」的过滤器抓不到它。
  // 它会被 stage-3 编译成 `^src/lib$`、匹配零个文件，于是该票所有改动都判越界。
  it('Touches 目录漏尾斜杠（含路径分隔符的写法）→ 拦下', () => {
    const flowDir = makeRepo('- [ ] T1 first\n  Blocked by: none\n  Touches: src/lib\n');
    const r = runGate(flowDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('`/` 结尾');
  });

  // 回归锚：`**` 编译成 `^.*$`，该票改什么都不越界——等于把断言⑥ 关掉，
  // 而「Touches 是并行安全的唯一依据」这句话就成了空的。
  it('Touches 通配全仓（** / * / ./）→ 拦下', () => {
    for (const v of ['**', '*', './', '.', '**/*']) {
      const flowDir = makeRepo(`- [ ] T1 first\n  Blocked by: none\n  Touches: ${v}\n`);
      const r = runGate(flowDir);
      expect(r.code, `Touches: ${v}`).toBe(1);
      expect(r.stderr).toContain('通配全仓');
    }
  });

  it('带扩展名的文件与带尾斜杠的目录并存 → 放行', () => {
    const flowDir = makeRepo(
      '- [ ] T1 first\n  Blocked by: none\n  Touches: src/lib/state.ts src/hooks/ tests/*.test.ts\n'
    );
    expect(runGate(flowDir).code).toBe(0);
  });

  it('Touches 花括号展开 / 反斜杠分隔符 → 拦下', () => {
    const brace = makeRepo('- [ ] T1 first\n  Blocked by: none\n  Touches: src/{a,b}.ts\n');
    expect(runGate(brace).code).toBe(1);
    const back = makeRepo('- [ ] T1 first\n  Blocked by: none\n  Touches: src\\lib\\x.ts\n');
    const r = runGate(back);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('反斜杠');
  });
});
