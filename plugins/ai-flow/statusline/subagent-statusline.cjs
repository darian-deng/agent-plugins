#!/usr/bin/env node
'use strict';
// ai-flow 的 subagentStatusLine：把 flow 进度写进 Claude Code 代理面板的子代理行。
//
// 由插件根 `settings.json` 的 `subagentStatusLine` 调起。宿主每 5 秒跑一次（只在面板里
// 有子代理时跑），stdin 是 { session_id, cwd, columns, tasks[] }，stdout 每行一个
// {"id","content"}：改写那一行；不输出 = 保留默认；不能新增行。
//
// 为什么不直接在 settings.json 里写 `${CLAUDE_PLUGIN_ROOT}/…`：那个变量在 settings 的
// command 里不展开（宿主只给这条命令注入 CLAUDE_PROJECT_DIR），展开成空串后静默失败。所以
// 引擎的 SessionStart 把本文件复制到 `<claude 配置目录>/ai-flow/`。见
// `src/lib/statusline-install.ts`。
//
// 纪律：只读、只用 Node 内置模块、任何异常都什么也不输出（面板保留默认行）。
// 这些行在面板里是可选中的子代理条目，宿主不许新增行——所以只往第一行前面挂一小段，别的不动。

const { existsSync, readFileSync, readdirSync } = require('fs');
const { join, dirname } = require('path');
const { homedir } = require('os');

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

function readActive(repoRoot, flowName) {
  const s = readJson(join(repoRoot, '.ai-flow', flowName, 'state', 'active.json'));
  return s && typeof s.current_stage === 'string' ? s : null;
}

// 与引擎 `resolveActiveFlow` 同一顺序：先查 session 绑定（与 cwd 无关），再从项目根往上找。
// 往上找时遇到第一个 `.ai-flow` 就停——子项目有自己（空闲）的锚点时不能落到父项目的 flow。
// 引擎在 linked worktree 里还会映射回主检出；主会话开在别的检出时引擎判它不属于这条 flow，
// 这里找不到、不显示，两者结论一致。
function resolveFlow(sessionId, startDir) {
  if (sessionId) {
    const safe = String(sessionId).replace(/[^A-Za-z0-9_.-]/g, '_');
    const b = readJson(join(claudeDir(), 'ai-flow', 'sessions', safe + '.json'));
    if (b && typeof b.projectRoot === 'string' && typeof b.flowName === 'string') {
      const state = readActive(b.projectRoot, b.flowName);
      if (state) return { repoRoot: b.projectRoot, flowName: b.flowName, state };
    }
  }
  let dir = startDir;
  while (dir) {
    const aiFlow = join(dir, '.ai-flow');
    if (existsSync(aiFlow)) {
      const found = [];
      for (const e of readdirSync(aiFlow, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const state = readActive(dir, e.name);
        if (state) found.push({ repoRoot: dir, flowName: e.name, state });
      }
      // 同一锚点多条 flow：优先本会话持有的那条。
      return found.find((f) => f.state.last_session_id === sessionId) || found[0] || null;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

// 派发约定：description 以 `T<n>·<段>` 开头（见 grill-flow references/per-ticket-review.md）。
function ticketOf(desc) {
  const m = /^\s*(T\d+)\s*[·・:：]/.exec(desc || '');
  return m ? m[1] : null;
}

// 终端显示宽度：CJK / 全角按 2 列。
function width(s) {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}
function clip(s, max) {
  if (width(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = width(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

// 宿主的终态（它自己判「停止 / 清除」按钮用的同一组值）。子代理结束后行还会在面板里留一会儿
// 才被收走，这些行不算「在跑」，也不挂 flow 信息。
const DONE = new Set(['completed', 'failed', 'killed']);

// 只加信息、不改别的行：第一个还在跑的子代理那一行前面挂「<flow> <stage>」，stage-3 再加在跑
// 几张票（还在跑、且 description 带票号的，按票号去重）。其它行不输出，保持宿主默认。
function render(input, env) {
  const tasks = (Array.isArray(input.tasks) ? input.tasks : []).filter((t) => !DONE.has(t.status));
  if (tasks.length === 0) return [];
  const start = env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const flow = resolveFlow(input.session_id, start);
  if (!flow) return [];
  let head = `${flow.flowName} ${flow.state.current_stage}`;
  if (flow.state.current_stage === 'stage-3') {
    const running = new Set(tasks.map((t) => ticketOf(t.description)).filter(Boolean));
    head += ` · 在跑 ${running.size} 张票`;
  }
  const first = tasks[0];
  const rest = first.label || first.description || first.name || '';
  const max = Math.max(20, (Number(input.columns) || 100) - 6);
  return [{ id: first.id, content: clip(`${head} ｜ ${rest}`, max) }];
}

module.exports = { render };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    try {
      const rows = render(JSON.parse(raw), process.env);
      if (rows.length) process.stdout.write(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    } catch { /* 任何异常都不输出：面板保留默认行 */ }
  });
}
