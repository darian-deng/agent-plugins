#!/usr/bin/env node
// grill-flow stage-3 的 Stop 守卫：主 session 一个回合结束、而**没有任何东西会在将来把它叫醒**
// 时，由引擎（`src/lib/stop-handler.ts`）调用，回答一个问题——「此刻有没有本可以推进的工作」。
//
// 引擎只在这些机械条件全成立时才跑本脚本：无子代理在飞、无待批 gate、无 `state/hold`、
// 且这回合不是开发者起的（他刚说过话的回合交给停滞自检的 5 分钟规则，别打断他读回答）。
// 引擎看得见的事实放在环境变量 `AI_FLOW_STOP_FACTS`（JSON），本脚本补上它看不见的：
// tickets.md 里还有几张票够格、state/worktrees 里还开着几棵树。
//
// 退出码协议：
//   3 → 这次停下是停滞：stdout 整段作为续跑指令注入给模型（一回合只续一次，宿主保证不链式）。
//   0 → 停下成立（收尾期无树可收 / 脚本判无事可做），引擎什么都不说。
//   其它 → 脚本故障：引擎记日志、不注入——坏掉的守卫绝不能凭空造回合。
//
// 存在理由（实测 0.80.2 十个 session）：主 session 以「我的下一步：立 T58…」「下一轮我把票
// 写出来派发」收尾、0 派发、无在飞，四次合计 359 分钟；「下一批 B35 = T62+T63+T66」算完落盘
// 却没派，55 分钟；「要我现在就派 T69 吗？」72 分钟。stage-3 提示词的「连续执行」节禁的是
// 「问要不要继续」，而这些都是**陈述**，模型不把它们识别为停下。提示词追一种形态漏一种，
// 所以判定权收回引擎：回合结束那一刻机械地数一遍，有活就说有活。
'use strict';

const { existsSync, readFileSync, readdirSync } = require('fs');
const { join, resolve } = require('path');
const { spawnSync } = require('child_process');

const LABEL = '[ai-flow:stop-guard]';
const CONTINUE = 3;

function fail(msg) { process.stderr.write(LABEL + ' ' + msg + '\n'); process.exit(1); }

let facts = {};
try { facts = JSON.parse(process.env.AI_FLOW_STOP_FACTS || '{}'); } catch (e) { fail('AI_FLOW_STOP_FACTS 不是 JSON: ' + e.message); }

const flowDir = process.env.AI_FLOW_FLOW_DIR ? resolve(process.env.AI_FLOW_FLOW_DIR) : null;
if (!flowDir) fail('缺 AI_FLOW_FLOW_DIR');

let state;
try { state = JSON.parse(readFileSync(join(flowDir, 'state', 'active.json'), 'utf-8')); }
catch (e) { fail('读不到 state/active.json: ' + e.message); }
const flowId = state.flow_id || facts.flow_id;
if (!flowId) fail('active.json 缺 flow_id');

// ── 开着的树：state/worktrees/<flow_id>-T<n>.json（worktree.cjs open 登记、close 删除） ──
const registry = join(flowDir, 'state', 'worktrees');
const openTrees = [];
if (existsSync(registry)) {
  for (const f of readdirSync(registry)) {
    const m = new RegExp('^' + flowId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(T\\d+)\\.json$').exec(f);
    if (m) openTrees.push(m[1]);
  }
}

// ── 够格未开：复用 schedule.cjs 的准入判据（同一份 tickets.md 同一个算法） ──
const schedule = join(__dirname, 'schedule.cjs');
const r = spawnSync(process.execPath, [schedule, '--flow-dir', flowDir, 'missed', '--json', ...openTrees], {
  encoding: 'utf-8', timeout: 15_000,
});
if (r.status !== 0) fail('schedule.cjs missed --json 失败: ' + ((r.stderr || r.stdout || '').trim() || ('exit ' + r.status)));
let sched;
try { sched = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) { fail('schedule.cjs 输出不是 JSON: ' + r.stdout.slice(0, 200)); }

const eligible = sched.eligible || [];
const wrappingUp = facts.wrap_up_pct !== null && facts.wrap_up_pct !== undefined;
const holdPath = facts.hold_path || join(flowDir, 'state', 'hold');
const signalPath = join(flowDir, 'state', 'signal');

// 收尾期（context 过线）只收不派：没有树要收就让它停。
if (wrappingUp && openTrees.length === 0) process.exit(0);

const lines = [];
const factBits = [
  '在飞子代理 0',
  `开着的树 ${openTrees.length}` + (openTrees.length ? `（${openTrees.join(' ')}）` : ''),
];
if (!wrappingUp) factBits.push(`够格未开 ${eligible.length}` + (eligible.length ? `（${eligible.join(' ')}）` : '') + `；未勾 ${sched.open}/${sched.total}`);
if (facts.bash_in_flight) {
  const names = (facts.bash_tasks || []).slice(0, 3).join('；');
  factBits.push(`后台 shell 任务 ${(facts.bash_tasks || []).length} 个（${names}）——它们不会把你叫醒，别当成在等它`);
}
lines.push(`${LABEL} 回合结束时的机械事实（引擎数的，不是开发者说的话）：${factBits.join('；')}。`);

if (sched.open === 0) {
  lines.push(`全部票已勾。stage-3 的完成动作是用 Write 向 \`${signalPath}\` 写 \`done\`——现在就写，不要等开发者。`);
} else if (wrappingUp) {
  lines.push(`context 已过收尾线：**只收不派**。开着的树按票面标记走完剩余段（派质量链 / 注释清理 / close / 记账），`
    + `然后重写交接段、结束回合。⛔ 不开新票。`);
} else if (openTrees.length === 0 && eligible.length === 0) {
  lines.push(`未勾的票没有一张够格（全部 Blocked by 未清）。可做的事：核对 Blocked by 是否成环或指向不存在的票；`
    + `按 execution-unit.md 跑 \`schedule.cjs\` 看依赖链；细化下一切片的粗票；跑欠的收口测试。`);
} else {
  lines.push(`没有任何东西会在将来把你叫醒。二选一，都在**本回合**做完：`);
  const todo = [];
  if (openTrees.length) todo.push(`开着的树（${openTrees.join(' ')}）→ 看票面已到哪段：无 impl:done → 派实施；有 impl:done 无 qc:done → 派质量链；有 qc:done → 注释清理 / close / 记账`);
  if (eligible.length) todo.push(`够格票（${eligible.join(' ')}）→ 先落 \`batch:\` 再开树、派实施（stage-3 第 2–3 步；批宽上限见提示词）`);
  lines.push(`① **推进**：${todo.join('；')}。⛔ 写「下一轮我…」「我的下一步是…」然后停，不是推进——就是这类收尾触发了本条。`);
  lines.push(`② **确实在等开发者的人手动作**（安全红线拍板 / L1–L2 确认 / 他明确叫停；⛔ 真机验证不算——打 \`rm:pending\` 留 stage-4）→ 用 Write 写 \`${holdPath}\`，`
    + `一行：等谁做什么、为什么只能他做、等到之后下一步。有这个文件引擎就不再催；他下一条输入会自动清掉。⛔ 只在正文里说「在等你」不算。`);
}

process.stdout.write(lines.join('\n') + '\n');
process.exit(CONTINUE);
