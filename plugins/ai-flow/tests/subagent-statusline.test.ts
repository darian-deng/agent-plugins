import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import { PLUGIN_ROOT } from '../src/lib/flow-paths.js';
import { developerStatusLine } from '../src/lib/format.js';
import {
  installSubagentStatusline, statuslineInstallDir, STATUSLINE_SCRIPT, STATUSLINE_SIDECAR,
} from '../src/lib/statusline-install.js';

const SCRIPT = join(PLUGIN_ROOT, 'statusline', STATUSLINE_SCRIPT);
const { render } = createRequire(import.meta.url)(SCRIPT) as {
  render: (input: unknown, env: Record<string, string | undefined>, now: number) => Array<{ id: string; content: string }>;
};

const NOW = Date.parse('2026-09-30T10:00:00Z');
const MIN = 60_000;
let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function repo(flow = 'grill-flow', state: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ai-flow-sl-'));
  dirs.push(root);
  const stateDir = join(root, '.ai-flow', flow, 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(root, '.ai-flow', flow, 'config.json'), '{}');
  writeFileSync(join(stateDir, 'active.json'), JSON.stringify({
    flow_id: 'F1', flow_name: flow, current_stage: 'stage-3', last_session_id: 'me',
    context_wrap_up: { at_pct: null }, ...state,
  }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(stateDir, rel, '..'), { recursive: true });
    writeFileSync(join(stateDir, rel), body);
  }
  return root;
}

const task = (id: string, description: string, startedMinAgo = 0) =>
  ({ id, name: 'a', type: 'local_agent', status: 'running', description, label: description, startTime: NOW - startedMinAgo * MIN });

function run(root: string, tasks: unknown[], extra: Record<string, unknown> = {}) {
  return render({ session_id: 'me', cwd: root, columns: 200, tasks, ...extra }, { CLAUDE_PROJECT_DIR: root }, NOW);
}

describe('subagent-statusline render', () => {
  it('没有子代理 / 没有 flow → 什么都不输出（面板保留默认行）', () => {
    const root = repo();
    expect(run(root, [])).toEqual([]);
    const bare = mkdtempSync(join(tmpdir(), 'ai-flow-sl-bare-'));
    dirs.push(bare);
    expect(run(bare, [task('a', 'x')])).toEqual([]);
  });

  it('stage-3：第一行带 flow 进度和票数，票行改写成人话，其它行保留默认', () => {
    const root = repo('grill-flow', {}, {
      'worktrees/F1-T1.json': JSON.stringify({ flow_id: 'F1' }),
      'worktrees/F1-T2.json': JSON.stringify({ flow_id: 'F1' }),
    });
    const rows = run(root, [task('a', 'T1·实施 open tree', 12), task('b', '对抗审查'), task('c', 'T2·质量链', 65)]);
    expect(rows).toEqual([
      { id: 'a', content: 'grill-flow 第 3/5 步：逐票实施 · 在做 2 张票 ｜ T1 写代码 · 已跑 12 分钟' },
      { id: 'c', content: 'T2 评审并提交 · 已跑 1 小时 5 分' },
    ]);
  });

  it('开着的票树没有代理在跑 → 说出几张；车道模式说车道数', () => {
    const root = repo('grill-flow', {}, {
      'worktrees/F1-T1.json': '{}', 'worktrees/F1-T7.json': '{}',
    });
    expect(run(root, [task('a', 'T1·注释清理')])[0]!.content)
      .toBe('grill-flow 第 3/5 步：逐票实施 · 在做 2 张票，其中 1 张暂时没有代理在跑 ｜ T1 清理注释 · 刚开始');
    const lanes = repo('grill-flow', {}, { 'worktrees/F1-R1.json': '{}', 'worktrees/F1-R2.json': '{}' });
    expect(run(lanes, [task('a', 'x')])[0]!.content).toContain('开着 2 条并行车道');
  });

  it('别的 flow 登记的树不算', () => {
    const root = repo('grill-flow', {}, { 'worktrees/OLD-T1.json': JSON.stringify({ flow_id: 'OLD' }) });
    expect(run(root, [task('a', 'x')])[0]!.content).toBe('grill-flow 第 3/5 步：逐票实施 ｜ x');
  });

  it('非 stage-3：只有进度，没有票', () => {
    const root = repo('grill-flow', { current_stage: 'stage-1' });
    expect(run(root, [task('a', '冷读审查')])[0]!.content).toBe('grill-flow 第 1/5 步：需求对齐 ｜ 冷读审查');
  });

  it('被另一个会话持有 → 提醒只读和怎么接管', () => {
    const root = repo('grill-flow', { last_session_id: 'other' });
    expect(run(root, [task('a', 'x')])[0]!.content)
      .toBe('⚠ grill-flow 由另一个会话持有，本会话只读；那个会话若已关闭，/clear 即可接管 ｜ x');
  });

  it('没有会话持有（resume 之后 / 原会话已退出）→ 提示 /clear 接管', () => {
    const root = repo('grill-flow', { last_session_id: null });
    expect(run(root, [task('a', 'x')])[0]!.content).toBe('grill-flow 第 3/5 步：逐票实施 · 暂无会话接管，/clear 即可接管 ｜ x');
  });

  it('在等开发者：hold 首行 / gate 待确认 / 上下文收尾', () => {
    const held = repo('grill-flow', {}, { hold: '## T9 要不要拆票\n细节…' });
    expect(run(held, [task('a', 'x')])[0]!.content).toContain('⏸ 在等你：T9 要不要拆票 ｜');
    const gated = repo('grill-flow', { current_stage: 'stage-1' }, { signal: 'done' });
    expect(run(gated, [task('a', 'x')])[0]!.content).toContain('这一步已完成，等你确认进下一步');
    const noGate = repo('grill-flow', { current_stage: 'stage-3' }, { signal: 'done' });
    expect(run(noGate, [task('a', 'x')])[0]!.content).not.toContain('等你确认');
    const wrap = repo('grill-flow', { context_wrap_up: { at_pct: 61 } });
    expect(run(wrap, [task('a', 'x')])[0]!.content).toContain('上下文快满了，正在收尾，收完请 /clear');
  });

  it('项目覆盖层整体替换 stages 时按覆盖后的数步数', () => {
    const root = repo();
    writeFileSync(join(root, '.ai-flow', 'grill-flow', 'config.json'),
      JSON.stringify({ stages: [{ id: 'stage-1' }, { id: 'stage-3', name: '实施' }] }));
    expect(run(root, [task('a', 'x')])[0]!.content).toBe('grill-flow 第 2/2 步：实施 ｜ x');
  });

  it('同一锚点两条 flow → 取本会话持有的那条', () => {
    const root = repo('feat-flow', { last_session_id: 'other', current_stage: 'stage-2' });
    mkdirSync(join(root, '.ai-flow', 'grill-flow', 'state'), { recursive: true });
    writeFileSync(join(root, '.ai-flow', 'grill-flow', 'config.json'), '{}');
    writeFileSync(join(root, '.ai-flow', 'grill-flow', 'state', 'active.json'),
      JSON.stringify({ flow_id: 'G', current_stage: 'stage-4', last_session_id: 'me' }));
    expect(run(root, [task('a', 'x')])[0]!.content).toBe('grill-flow 第 4/5 步：整体评审与合并 ｜ x');
  });

  it('会话绑定优先于项目目录（主会话 cd 走或项目根在锚点之上）', () => {
    const root = repo('grill-flow', { current_stage: 'stage-2', last_session_id: 'bound' });
    const sessions = join(process.env['CLAUDE_CONFIG_DIR']!, 'ai-flow', 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'bound.json'), JSON.stringify({ sessionId: 'bound', projectRoot: root, flowName: 'grill-flow' }));
    const elsewhere = mkdtempSync(join(tmpdir(), 'ai-flow-sl-else-'));
    dirs.push(elsewhere);
    const rows = render({ session_id: 'bound', cwd: elsewhere, columns: 200, tasks: [task('a', 'x')] },
      { CLAUDE_PROJECT_DIR: elsewhere }, NOW);
    expect(rows[0]!.content).toContain('第 2/5 步：写规格与切票');
  });

  it('按 columns 截断（中文按两列算）', () => {
    const root = repo('grill-flow', {}, { hold: '很长'.repeat(50) });
    const content = render({ session_id: 'me', columns: 40, tasks: [task('a', 'x')] }, { CLAUDE_PROJECT_DIR: root }, NOW)[0]!.content;
    expect(content.endsWith('…')).toBe(true);
    expect([...content].reduce((w, ch) => w + (/[一-鿿｜：，]/.test(ch) ? 2 : 1), 0)).toBeLessThanOrEqual(34);
  });

  it('作为命令跑：输出 JSON 行；输入坏了什么也不输出、退出码 0', () => {
    const root = repo('grill-flow', { current_stage: 'stage-5' });
    const ok = spawnSync('node', [SCRIPT], {
      input: JSON.stringify({ session_id: 'me', columns: 120, tasks: [task('a', 'x')] }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: 'utf-8',
    });
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout.trim())).toEqual({ id: 'a', content: 'grill-flow 第 5/5 步：知识沉淀 ｜ x' });
    const bad = spawnSync('node', [SCRIPT], { input: 'not json', encoding: 'utf-8' });
    expect(bad.status).toBe(0);
    expect(bad.stdout).toBe('');
  });
});

describe('installSubagentStatusline', () => {
  it('复制脚本并记下插件根；内容没变就不重写', () => {
    installSubagentStatusline();
    const dir = statuslineInstallDir();
    const dest = join(dir, STATUSLINE_SCRIPT);
    expect(readFileSync(dest, 'utf-8')).toBe(readFileSync(SCRIPT, 'utf-8'));
    expect(JSON.parse(readFileSync(join(dir, STATUSLINE_SIDECAR), 'utf-8'))).toEqual({ pluginRoot: PLUGIN_ROOT });
    const before = statSync(dest).mtimeMs;
    installSubagentStatusline();
    expect(statSync(dest).mtimeMs).toBe(before);
  });

  it('复制过去的脚本从旁路文件找到插件自带的 flow 定义', () => {
    installSubagentStatusline();
    const root = repo('grill-flow', { current_stage: 'stage-2' });
    const out = spawnSync('node', [join(statuslineInstallDir(), STATUSLINE_SCRIPT)], {
      input: JSON.stringify({ session_id: 'me', columns: 120, tasks: [task('a', 'x')] }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: 'utf-8',
    });
    expect(JSON.parse(out.stdout.trim()).content).toBe('grill-flow 第 2/5 步：写规格与切票 ｜ x');
  });

  it('插件里没有脚本 → 什么也不做、不抛', () => {
    const fake = mkdtempSync(join(tmpdir(), 'ai-flow-sl-plugin-'));
    dirs.push(fake);
    expect(() => installSubagentStatusline(fake)).not.toThrow();
  });
});

describe('plugin settings.json', () => {
  it('只声明 subagentStatusLine，命令指向安装位置', () => {
    const settings = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'settings.json'), 'utf-8'));
    expect(Object.keys(settings)).toEqual(['subagentStatusLine']);
    expect(settings.subagentStatusLine.type).toBe('command');
    expect(settings.subagentStatusLine.command).toContain(`ai-flow/${STATUSLINE_SCRIPT}`);
    expect(settings.subagentStatusLine.command).not.toContain('CLAUDE_PLUGIN_ROOT');
  });
});

describe('developerStatusLine', () => {
  const stages = [{ id: 'stage-1', name: '需求对齐' }, { id: 'stage-2' }];
  it('位置 + 名字；没名字只报位置；gate 待确认说要你做什么', () => {
    expect(developerStatusLine({ flowName: 'f', stages, stageId: 'stage-1', gatePending: false })).toBe('f 第 1/2 步：需求对齐');
    expect(developerStatusLine({ flowName: 'f', stages, stageId: 'stage-2', gatePending: true }))
      .toBe('f 第 2/2 步 · 这一步已完成，等你确认进下一步');
  });
});

it('插件内的脚本存在', () => {
  expect(existsSync(resolve(SCRIPT))).toBe(true);
});
