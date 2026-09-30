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
// 引擎的 SessionStart 把本文件复制到 `<claude 配置目录>/ai-flow/`，并在旁边写一份
// `subagent-statusline.json` 记下插件根（要读插件自带的 flow 定义）。见
// `src/lib/statusline-install.ts`。
//
// 纪律：只读、只用 Node 内置模块、任何异常都什么也不输出（面板保留默认行）。

const { existsSync, readFileSync, readdirSync } = require('fs');
const { join, dirname, resolve } = require('path');
const { homedir } = require('os');

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}
function readText(p) {
  try { return readFileSync(p, 'utf-8'); } catch { return null; }
}

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

function pluginRoot() {
  const side = readJson(join(__dirname, 'subagent-statusline.json'));
  if (side && typeof side.pluginRoot === 'string') return side.pluginRoot;
  // 直接从插件目录里跑（测试）时，插件根就是上一级。
  return resolve(__dirname, '..');
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

// 插件默认在下、项目稀疏覆盖层在上；`stages` 存在则整体替换（与 flow-config-loader 同口径）。
function loadStages(repoRoot, flowName) {
  const own = readJson(join(repoRoot, '.ai-flow', flowName, 'config.json')) || {};
  if (Array.isArray(own.stages)) return own.stages;
  const def = readJson(join(pluginRoot(), '.ai-flow', flowName, 'config.json'));
  return def && Array.isArray(def.stages) ? def.stages : [];
}

// 与引擎 `isGatePending` 同口径。
function gatePending(repoRoot, flowName, stages, idx) {
  const stage = stages[idx];
  if (!stage || !stage.completion || !stage.completion.gate) return false;
  const signal = (readText(join(repoRoot, '.ai-flow', flowName, 'state', 'signal')) || '').trim();
  if (!signal) return false;
  if (signal === 'done') return true;
  const next = stages[idx + 1];
  return next ? signal === next.id : signal === 'flow-complete';
}

// 本 flow 开着的票树：`state/worktrees/<树名>.json`（worktree.cjs open 登记、close 删除）。
function openTrees(repoRoot, flowName, flowId) {
  const dir = join(repoRoot, '.ai-flow', flowName, 'state', 'worktrees');
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    const rec = readJson(join(dir, f));
    if (rec && rec.flow_id && rec.flow_id !== flowId) continue;
    const base = f.slice(0, -'.json'.length);
    out.push(base.startsWith(flowId + '-') ? base.slice(flowId.length + 1) : base);
  }
  return out;
}

const STEP_WORDS = {
  '实施': '写代码',
  '续做': '接着写代码',
  '复派': '重做',
  '质量链': '评审并提交',
  '注释清理': '清理注释',
};

// 派发约定：description 以 `T<n>·<段>` 开头（见 grill-flow references/per-ticket-review.md）。
function parseTicket(desc) {
  const m = /^\s*(T\d+)\s*[·・:：]\s*([^\s·・:：,，(（]+)/.exec(desc || '');
  return m ? { ticket: m[1], step: STEP_WORDS[m[2]] || m[2] } : null;
}

function elapsed(startTime, now) {
  if (typeof startTime !== 'number' || !isFinite(startTime)) return '';
  const ms = startTime < 1e12 ? startTime * 1000 : startTime;
  const min = Math.floor((now - ms) / 60000);
  if (min < 1) return '刚开始';
  if (min < 60) return `已跑 ${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `已跑 ${h} 小时 ${m} 分` : `已跑 ${h} 小时`;
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

function flowLine(flow, sessionId, stages, now, tasks) {
  const { repoRoot, flowName, state } = flow;
  const owner = state.last_session_id;
  if (owner && owner !== sessionId) {
    return `⚠ ${flowName} 由另一个会话持有，本会话只读；那个会话若已关闭，/clear 即可接管`;
  }
  const idx = stages.findIndex((s) => s && s.id === state.current_stage);
  const stage = stages[idx];
  let line = idx >= 0
    ? `${flowName} 第 ${idx + 1}/${stages.length} 步${stage.name ? '：' + stage.name : ''}`
    : `${flowName} ${state.current_stage}`;
  if (!owner) return line + ' · 暂无会话接管，/clear 即可接管';

  const parts = [line];
  const hold = readText(join(repoRoot, '.ai-flow', flowName, 'state', 'hold'));
  if (hold !== null && hold.trim()) {
    const first = hold.trim().split('\n')[0].replace(/^[#>\-*\s]+/, '').trim();
    parts.push(`⏸ 在等你：${first}`);
  } else if (idx >= 0 && gatePending(repoRoot, flowName, stages, idx)) {
    parts.push('这一步已完成，等你确认进下一步');
  }
  if (state.context_wrap_up && state.context_wrap_up.at_pct != null) {
    parts.push('上下文快满了，正在收尾，收完请 /clear');
  }
  const trees = openTrees(repoRoot, flowName, state.flow_id);
  if (trees.length > 0) {
    const tickets = trees.filter((t) => /^T\d+$/.test(t));
    if (tickets.length === trees.length) {
      const busy = new Set(tasks.map((t) => (parseTicket(t.description) || {}).ticket).filter(Boolean));
      const idle = tickets.filter((t) => !busy.has(t)).length;
      parts.push(idle ? `在做 ${tickets.length} 张票，其中 ${idle} 张暂时没有代理在跑` : `在做 ${tickets.length} 张票`);
    } else {
      parts.push(`开着 ${trees.length} 条并行车道`);
    }
  }
  return parts.join(' · ');
}

function render(input, env, now) {
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  if (tasks.length === 0) return [];
  const sessionId = input.session_id;
  const start = env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const flow = resolveFlow(sessionId, start);
  if (!flow) return [];
  const stages = loadStages(flow.repoRoot, flow.flowName);
  const max = Math.max(20, (Number(input.columns) || 100) - 6);

  const rows = [];
  tasks.forEach((t, i) => {
    const tk = parseTicket(t.description);
    let body = tk ? `${tk.ticket} ${tk.step}${elapsed(t.startTime, now) ? ' · ' + elapsed(t.startTime, now) : ''}` : null;
    if (i === 0) {
      const head = flowLine(flow, sessionId, stages, now, tasks);
      body = `${head} ｜ ${body || t.label || t.description || t.name || ''}`;
    }
    if (body !== null) rows.push({ id: t.id, content: clip(body, max) });
  });
  return rows;
}

module.exports = { render };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    try {
      const rows = render(JSON.parse(raw), process.env, Date.now());
      if (rows.length) process.stdout.write(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    } catch { /* 任何异常都不输出：面板保留默认行 */ }
  });
}
