import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import { PLUGIN_ROOT } from '../src/lib/flow-paths.js';
import { developerStatusLine } from '../src/lib/format.js';
import { handleUserPrompt } from '../src/lib/userprompt-handler.js';
import type { UserPromptInput } from '../src/lib/types.js';
import {
  installSubagentStatusline, statuslineInstallDir, STATUSLINE_SCRIPT,
} from '../src/lib/statusline-install.js';

const SCRIPT = join(PLUGIN_ROOT, 'statusline', STATUSLINE_SCRIPT);
const { render } = createRequire(import.meta.url)(SCRIPT) as {
  render: (input: unknown, env: Record<string, string | undefined>) => Array<{ id: string; content: string }>;
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
  return render({ session_id: 'me', cwd: root, columns: 200, tasks, ...extra }, { CLAUDE_PROJECT_DIR: root });
}

describe('subagent-statusline render', () => {
  it('没有子代理 / 没有 flow → 什么都不输出（面板保留默认行）', () => {
    const root = repo();
    expect(run(root, [])).toEqual([]);
    const bare = mkdtempSync(join(tmpdir(), 'ai-flow-sl-bare-'));
    dirs.push(bare);
    expect(run(bare, [task('a', 'x')])).toEqual([]);
  });

  it('stage-3：只改第一行，挂 flow、stage 和在跑几张票（按票号去重）；其它行保持默认', () => {
    const root = repo();
    const rows = run(root, [task('a', 'T208·质量链'), task('b', '对抗审查'), task('c', 'T204·实施'), task('d', 'T204·注释清理')]);
    expect(rows).toEqual([{ id: 'a', content: 'grill-flow stage-3 · 在跑 2 张票 ｜ T208·质量链' }]);
  });

  it('已结束但还没被收走的行：不计数、不挂信息；全结束了就什么都不输出', () => {
    const done = (id: string, d: string, status: string) => ({ ...task(id, d), status });
    const rows = run(repo(), [done('a', 'T1·实施', 'completed'), task('b', 'T2·实施'), done('c', 'T3·质量链', 'failed')]);
    expect(rows).toEqual([{ id: 'b', content: 'grill-flow stage-3 · 在跑 1 张票 ｜ T2·实施' }]);
    expect(run(repo(), [done('a', 'T1·实施', 'killed')])).toEqual([]);
  });

  it('stage-3 没有带票号的子代理 → 在跑 0 张票', () => {
    expect(run(repo(), [task('a', '对抗审查')])[0]!.content).toBe('grill-flow stage-3 · 在跑 0 张票 ｜ 对抗审查');
  });

  it('非 stage-3：只有 flow 和 stage', () => {
    const root = repo('grill-flow', { current_stage: 'stage-1' });
    expect(run(root, [task('a', 'T1·实施')])).toEqual([{ id: 'a', content: 'grill-flow stage-1 ｜ T1·实施' }]);
  });

  it('同一锚点两条 flow → 取本会话持有的那条', () => {
    const root = repo('feat-flow', { last_session_id: 'other', current_stage: 'stage-2' });
    mkdirSync(join(root, '.ai-flow', 'grill-flow', 'state'), { recursive: true });
    writeFileSync(join(root, '.ai-flow', 'grill-flow', 'config.json'), '{}');
    writeFileSync(join(root, '.ai-flow', 'grill-flow', 'state', 'active.json'),
      JSON.stringify({ flow_id: 'G', current_stage: 'stage-4', last_session_id: 'me' }));
    expect(run(root, [task('a', 'x')])[0]!.content).toBe('grill-flow stage-4 ｜ x');
  });

  it('会话绑定优先于项目目录（主会话 cd 走或项目根在锚点之上）', () => {
    const root = repo('grill-flow', { current_stage: 'stage-2', last_session_id: 'bound' });
    const sessions = join(process.env['CLAUDE_CONFIG_DIR']!, 'ai-flow', 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'bound.json'), JSON.stringify({ sessionId: 'bound', projectRoot: root, flowName: 'grill-flow' }));
    const elsewhere = mkdtempSync(join(tmpdir(), 'ai-flow-sl-else-'));
    dirs.push(elsewhere);
    const rows = render({ session_id: 'bound', cwd: elsewhere, columns: 200, tasks: [task('a', 'x')] },
      { CLAUDE_PROJECT_DIR: elsewhere });
    expect(rows[0]!.content).toBe('grill-flow stage-2 ｜ x');
  });

  it('按 columns 截断（中文按两列算）', () => {
    const root = repo();
    const content = render({ session_id: 'me', columns: 40, tasks: [task('a', '很长'.repeat(50))] }, { CLAUDE_PROJECT_DIR: root })[0]!.content;
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
    expect(JSON.parse(ok.stdout.trim())).toEqual({ id: 'a', content: 'grill-flow stage-5 ｜ x' });
    const bad = spawnSync('node', [SCRIPT], { input: 'not json', encoding: 'utf-8' });
    expect(bad.status).toBe(0);
    expect(bad.stdout).toBe('');
  });
});

describe('installSubagentStatusline', () => {
  it('复制脚本；内容没变就不重写', () => {
    installSubagentStatusline();
    const dir = statuslineInstallDir();
    const dest = join(dir, STATUSLINE_SCRIPT);
    expect(readFileSync(dest, 'utf-8')).toBe(readFileSync(SCRIPT, 'utf-8'));
    const before = statSync(dest).mtimeMs;
    installSubagentStatusline();
    expect(statSync(dest).mtimeMs).toBe(before);
  });

  it('复制过去的脚本能独立跑', () => {
    installSubagentStatusline();
    const root = repo('grill-flow', { current_stage: 'stage-2' });
    const out = spawnSync('node', [join(statuslineInstallDir(), STATUSLINE_SCRIPT)], {
      input: JSON.stringify({ session_id: 'me', columns: 120, tasks: [task('a', 'x')] }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: 'utf-8',
    });
    expect(JSON.parse(out.stdout.trim()).content).toBe('grill-flow stage-2 ｜ x');
  });

  it('UserPromptSubmit 也会刷新（/reload-plugins 不触发 SessionStart）', async () => {
    const dest = join(statuslineInstallDir(), STATUSLINE_SCRIPT);
    mkdirSync(statuslineInstallDir(), { recursive: true });
    writeFileSync(dest, '// 旧版本');
    const root = mkdtempSync(join(tmpdir(), 'ai-flow-sl-up-'));
    dirs.push(root);
    await handleUserPrompt({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: root, prompt: 'hi' } as UserPromptInput);
    expect(readFileSync(dest, 'utf-8')).toBe(readFileSync(SCRIPT, 'utf-8'));
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
  it('flow + stage id；gate 待确认时说等你 approve', () => {
    expect(developerStatusLine({ flowName: 'f', stageId: 'stage-1', gatePending: false })).toBe('f stage-1');
    expect(developerStatusLine({ flowName: 'f', stageId: 'stage-2', gatePending: true })).toBe('f stage-2 · 等你 approve');
  });
});

it('插件内的脚本存在', () => {
  expect(existsSync(resolve(SCRIPT))).toBe(true);
});
