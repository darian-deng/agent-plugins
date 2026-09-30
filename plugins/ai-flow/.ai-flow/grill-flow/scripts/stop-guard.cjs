#!/usr/bin/env node
// grill-flow stage-3 的 Stop 守卫：主 session 一个回合结束、而**没有任何东西会在将来把它叫醒**
// 时，由引擎（`src/lib/stop-handler.ts`）调用，回答一个问题——「此刻有没有本可以推进的工作」。
//
// 引擎只在这些机械条件全成立时才跑本脚本：无待批 gate、无 `state/hold`、
// 且这回合不是开发者起的（他刚说过话的回合交给停滞自检的 5 分钟规则，别打断他读回答）。
// 有子代理在飞时也跑（0.88.3 起）：那时只问一件事——名额空着、够格票却没开（见文件末尾）。
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
// 闲置树（票面 `idle:`，如在飞途中被补了依赖、或在等开发者）：开着但此刻无活可派。
// 不排除它，守卫会把「无 impl:done」读成「该派实施」，催主 session 往一棵依赖未满足的树里派人。
const idleTrees = (sched.idle || []).filter((t) => openTrees.includes(t));
const activeTrees = openTrees.filter((t) => !idleTrees.includes(t));
const frozen = sched.frozen || [];
const freezeDesc = (sched.freeze || []).filter((f) => f.count > 0).map((f) => `${f.id} 冻 ${f.count} 张，解冻: ${f.lift || '未写'}`).join('；');
const wrappingUp = facts.wrap_up_pct !== null && facts.wrap_up_pct !== undefined;
const holdPath = facts.hold_path || join(flowDir, 'state', 'hold');
const signalPath = join(flowDir, 'state', 'signal');

// 收尾期（context 过线）只收不派：没有树要收就让它停。
if (wrappingUp && activeTrees.length === 0) process.exit(0);

// ── 有子代理在飞：只查「名额空着、够格票没开」 ──
// 在飞的代理会把你叫醒，所以这里不催「推进开着的树」——那些树的下一段在它们的代理回报时
// 自然会做；而按 description 认不出票号的代理（前缀没按约定写）会被当成「树上没人」，
// 这时催派就是在教人往一棵有人的树里再派一个。够格票是还没开树的票，不存在这个风险。
// 实测（0.88.2，一条 150+ 票的 flow）：回合结束时 6 个名额只占 4 个、5 张票够格，
// 连着几个回合没有任何东西问一句——原先引擎在「有代理在飞」时直接跳过本脚本。
if (facts.agents_in_flight) {
  if (wrappingUp || sched.open === 0 || eligible.length === 0) process.exit(0);
  const busy = new Set();
  for (const d of facts.agent_tasks || []) {
    const m = /^\s*(T\d+)\s*[·・:：]/.exec(d);
    if (m) busy.add(m[1]);
  }
  const cap = sched.cap || 6;
  const free = cap - busy.size;
  if (free <= 0) process.exit(0);
  const take = eligible.slice(0, free);
  process.stdout.write([
    `${LABEL} 回合结束时名额没占满（引擎数的，不是开发者说的话）：有代理在跑的票 ${busy.size} 张`
      + (busy.size ? `（${[...busy].join(' ')}）` : '') + `，上限 ${cap}，空 ${free} 个；`
      + `够格未开 ${eligible.length} 张（${eligible.join(' ')}，已按取票顺序排好）。`,
    `**本回合**就补上：${take.join(' ')} → 先落 \`batch:\` + \`with:\` 再开树、派实施（stage-3 第 2–3 步）。`
      + `⛔ 别等在飞的代理回来再一起开——它们回来之前这 ${free} 个名额一直空着。`,
    `票数按在飞代理 description 的 \`T<n>·\` 前缀认；某个在跑的代理没按这个前缀写就会被漏数——`
      + `真满了就在回复里说明哪几个代理占着名额，然后结束回合。`
      + `某张够格票确实要等开发者拍板才能开，按 \`freeze.md\` 给它登记冻结面（冻住的票不再算够格）；整体停派才用 Write 写 \`${holdPath}\`。`,
  ].join('\n') + '\n');
  process.exit(CONTINUE);
}

const lines = [];
const factBits = [
  '在飞子代理 0',
  `开着的树 ${openTrees.length}` + (openTrees.length ? `（${openTrees.join(' ')}）` : '')
    + (idleTrees.length ? `，其中闲置 ${idleTrees.length}（${idleTrees.join(' ')}，票面 idle:，不催）` : ''),
];
if (!wrappingUp) {
  factBits.push(`够格未开 ${eligible.length}` + (eligible.length ? `（${eligible.join(' ')}）` : '') + `；未勾 ${sched.open}/${sched.total}`);
  if (frozen.length) factBits.push(`冻结面冻住 ${frozen.length}（${freezeDesc}）`);
}
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
} else if (activeTrees.length === 0 && eligible.length === 0 && frozen.length > 0) {
  lines.push(`够格 0 是因为冻结面（${freezeDesc}）。这是**等门期**，不是停点——按 \`freeze.md\` 的等门期工单做：`
    + `细化下一切片的粗票（补机器判据与 Touches）/ 为冻结票预落 AC 与 Touches 收窄 / 跑欠的收口测试 / 收口 candidates.md。`
    + `解冻条件是否已满足也核一遍——满足就在那条冻结面下写 \`- lifted: <日期>\` 然后开票。`
    + `真的一件都没有 → 用 Write 写 \`${holdPath}\`，一行写清冻结面 id 与解冻条件（等谁做什么）。`);
} else if (activeTrees.length === 0 && eligible.length === 0) {
  lines.push(`未勾的票没有一张够格（全部 Blocked by 未清）。可做的事：核对 Blocked by 是否成环或指向不存在的票；`
    + `按 execution-unit.md 跑 \`schedule.cjs\` 看依赖链；细化下一切片的粗票；跑欠的收口测试。`);
} else {
  lines.push(`没有任何东西会在将来把你叫醒。二选一，都在**本回合**做完：`);
  const todo = [];
  if (activeTrees.length) todo.push(`开着的树（${activeTrees.join(' ')}）→ 看票面已到哪段：无 impl:done → 派实施；有 impl:done 无 qc:done → 派质量链；有 qc:done → 注释清理 / close / 记账`);
  if (eligible.length) todo.push(`够格票（${eligible.join(' ')}）→ 先落 \`batch:\` + \`with:\` 再开树、派实施（stage-3 第 2–3 步；并发上限见提示词）`);
  lines.push(`① **推进**：${todo.join('；')}。⛔ 写「下一轮我…」「我的下一步是…」然后停，不是推进——就是这类收尾触发了本条。`);
  lines.push(`② **确实在等开发者的人手动作**（安全红线拍板 / L1–L2 确认 / 他明确叫停；⛔ 真机验证不算——打 \`rm:pending\` 留 stage-4）→ 用 Write 写 \`${holdPath}\`，`
    + `一行：等谁做什么、为什么只能他做、等到之后下一步。有这个文件引擎就不再催；他下一条输入会自动清掉。⛔ 只在正文里说「在等你」不算。`);
}

process.stdout.write(lines.join('\n') + '\n');
process.exit(CONTINUE);
