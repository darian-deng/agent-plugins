#!/usr/bin/env node
// grill-flow stage-3 的 Stop 守卫：主 session 一个回合结束、而**没有任何东西会在将来把它叫醒**
// 时，由引擎（`src/lib/stop-handler.ts`）调用，回答一个问题——「此刻有没有本可以推进的工作」。
//
// 引擎只在这些机械条件全成立时才跑本脚本：无待批 gate、无 `state/hold`（收尾写的 `wrap-up:` hold 在 /clear 时由引擎清掉）。
// 开发者本 session 还没开口也跑（0.90.1 起：/clear 前说过的「继续」仍然有效），只是那时引擎不要求起看门狗。
// 有子代理在飞时也跑（0.88.3 起）、开发者起的回合也跑（0.90.0 起）：这两种情形只问一件事——
// 名额空着、够格票却没开（见「只查名额」那一节），别的一概不说。
// 开发者回合原先整段豁免（怕打断他读回答），实测代价：他说「继续」后的整个开场都没人数名额，
// 一次入场 14 分钟才打满 6 个名额；而开发者要的正是「时刻想着名额有没有打满」。
// 引擎看得见的事实放在环境变量 `AI_FLOW_STOP_FACTS`（JSON），本脚本补上它看不见的：
// tickets.md 里还有几张票够格、state/worktrees 里还开着几棵树。
//
// 退出码协议：
//   3 → 这次停下是停滞：stdout 整段作为续跑指令注入给模型（一回合只续一次，宿主保证不链式）。
//   0 → 停下成立（名额已满 / 车道模式 / 脚本判无事可做），引擎什么都不说。
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
// 登记残留：登记文件还在、树目录已经没了（手动删树、prune 过、close 半途失败）。不排除的话
// 守卫会一直当它「开着待收」——实测两棵这样的残留让收尾分支永远判「还有树要收」、每回合续跑，
// 主 session 两次把它们写进交接段又被冷读报「不存在」。
const staleTrees = [];
if (existsSync(registry)) {
  for (const f of readdirSync(registry)) {
    const m = new RegExp('^' + flowId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(T\\d+)\\.json$').exec(f);
    if (!m) continue;
    let p = null;
    try { p = JSON.parse(readFileSync(join(registry, f), 'utf-8')).path || null; } catch { /* 半截文件：按开着算 */ }
    if (p && !existsSync(p)) staleTrees.push(m[1]);
    else openTrees.push(m[1]);
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
const developerTurn = facts.developer_turn === true;

// 收口测试是否在跑：`schedule.cjs collect` 持有的锁；collect 进程与收口命令的进程组都不在才视为不在。
let collecting = null;
try {
  const held = JSON.parse(readFileSync(join(flowDir, 'state', 'collecting.json'), 'utf-8'));
  const probe = (id) => { try { process.kill(id, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  if ((held.pid > 0 && probe(held.pid)) || (held.pgid > 0 && probe(-held.pgid))) collecting = held;
} catch { /* 没有锁 */ }

// 开发者起的回合、又在收尾期：收尾分支是给「没人起的回合」催写交接用的，开发者正在和你说话时不插嘴。
if (wrappingUp && developerTurn) process.exit(0);

// ── 收尾期（context 过线）：只写交接、写 hold，不推进 ──
// 走到这里说明还没写 hold（有 hold 引擎不会跑本脚本）。0.89.1 之前这里是「只收不派，开着的树
// 走完剩余段」：实测收尾因此拖到 20–59 分钟（等地板、派质量链、跑整仓回归），而写交接本身只要
// 1–2 分钟；在飞代理与开着的树 /clear 后都由新 session 接（回报会送过去、相位表覆盖各段）。
if (wrappingUp) {
  const trees = openTrees.length ? `开着的树 ${openTrees.join(' ')}` : '没有开着的树';
  process.stdout.write([
    `${LABEL} context 已过收尾线，但 \`${holdPath}\` 还没写（引擎数的，不是开发者说的话）。${trees}`
      + (facts.agents_in_flight ? `；有子代理在飞（${(facts.agent_tasks || []).join('；') || '未带描述'}）` : '')
      + (staleTrees.length ? `；登记残留 ${staleTrees.join(' ')}（登记文件在、树目录已不在，别写进交接段当开着的树）` : '') + '。',
    `**本回合**只做三件事：① 交接段写清每棵开着的树走到哪一段、每个在飞代理一行（格式见 \`handoff.md\`「/clear 会带走什么」）；`
      + `② 用 Write 写 \`${holdPath}\`（一行，以 \`wrap-up:\` 开头：等开发者 /clear、在飞票号、下个 session 先读哪；只有开发者叫停了整体派发才别带这个前缀——/clear 时引擎只清带前缀的；某张票在等他拍板不算，那张票按 freeze.md 登记冻结面）；③ 告诉开发者可以 /clear（按 handoff.md 触发条件要冷读的，冷读改完再说）。`,
    `⛔ 不派新代理、不 close、不等地板或整仓回归——它们都留给新 session。已经回来的回报照常裁决、把裁定写上票面（\`mark\`），但不派下一段。`,
    ...(sched.open === 0 && openTrees.length === 0 ? [`全部票已勾、也没有开着的树：先用 Write 向 \`${signalPath}\` 写 \`done\` 推进 stage，再做上面三件事。`] : []),
  ].join('\n') + '\n');
  process.exit(CONTINUE);
}

// ── 只查名额用没用足（有子代理在飞，或开发者起的回合） ──
// 实测（0.88.2，一条 150+ 票的 flow）：回合结束时 6 个名额只占 4 个、5 张票够格，
// 连着几个回合没有任何东西问一句——原先引擎在「有代理在飞」时直接跳过本脚本。
// 两类没用足：① 开着、没标 idle:、却没代理在跑的树——它的下一段迟早要派，所以它占名额，
// 并且先点名推进它（不算进去，名额会先借给新票，等它派下一段时同时在跑的就超过上限）；
// ② 名额还空、够格票没开。
// ⚠️ ① 的风险：代理的 description 没带 `T<n>·` 前缀，它的树会被当成「没人跑」。三段派发
// 约定都要求这个前缀（per-ticket-review.md / quality-chain.md），文案里也写明「其实有代理在跑
// 就别重派、点明是哪个」——宁可让主 session 多核对一次，也不让名额静默空着。
if (facts.agents_in_flight || developerTurn) {
  // 车道模式（登记里有 `<flow_id>-R<n>` 的长驻树）：名额是车道、在飞票记在票面 `wip:` 上，
  // 这里的「开树补位」话术不适用，而且 openTrees 只认 T<n> ⇒ 在飞票会被当成够格——实测会
  // 催「重派正在跑的票」。车道模式不催补位，交给它自己的节奏。
  const laneRe = new RegExp('^' + flowId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-R\\d+\\.json$');
  const laneMode = existsSync(registry) && readdirSync(registry).some((f) => laneRe.test(f));
  if (laneMode || sched.open === 0) process.exit(0);
  const busy = new Set();
  for (const d of facts.agent_tasks || []) {
    const m = /^\s*(T\d+)\s*[·・:：]/.exec(d);
    if (m) busy.add(m[1]);
  }
  // 占名额的 = 有代理在跑的票 ∪ 开着、没标 idle:、此刻却没人跑的树（下一段迟早要派，
  // 不算进去就会先把名额借给新票，等它派下一段时同时在跑的就超过上限）。
  const stalled = activeTrees.filter((t) => !busy.has(t));
  // 开发者回合且收口在跑：没人跑的树多半只差 close（收口挡着），在他说话时点名它们是噪音——
  // 但它们照样占名额，否则会把名额借给新票、开出超过上限的树。
  const named = developerTurn && collecting ? [] : stalled;
  const occupied = new Set([...busy, ...stalled]);
  const cap = sched.cap || 6;
  const free = cap - occupied.size;
  const fresh = eligible.filter((t) => !busy.has(t) && !openTrees.includes(t));
  if (named.length === 0 && (free <= 0 || fresh.length === 0)) process.exit(0);
  const take = fresh.slice(0, Math.max(0, free));
  const out = [
    `${LABEL} 回合结束时名额没用足（引擎数的，不是开发者说的话）：有代理在跑的票 ${busy.size} 张`
      + (busy.size ? `（${[...busy].join(' ')}）` : '')
      + (stalled.length ? `，开着却没代理在跑的树 ${stalled.length} 棵（${stalled.join(' ')}）` : '')
      + `，上限 ${cap}，空 ${Math.max(0, free)} 个；够格未开 ${fresh.length} 张` + (fresh.length ? `（${fresh.join(' ')}，已按取票顺序排好）` : '') + '。',
  ];
  if (named.length) {
    out.push(`**本回合**先推进没人跑的树（${named.join(' ')}）：看票面到哪段——无 impl:done → 派实施；有 impl:done 无 qc:done → 派质量链；有 qc:done → 注释清理 / close / 记账。`
      + `（它的代理其实还在跑、只是 description 没带 \`T<n>·\` 前缀 → 别重派，在回复里点明是哪个代理。）`
      + (collecting ? `收口 ${collecting.label || ''} 正在跑：只差 close 的树等它结束（结束通知会叫醒你），别的段照推。` : ''));
  }
  if (take.length) {
    out.push(`**本回合**再补上：${take.join(' ')} → 先落 \`batch:\` + \`with:\` 再开树、派实施（stage-3 第 2–3 步）。`
      + (facts.agents_in_flight ? `⛔ 别等在飞的代理回来再一起开——它们回来之前这 ${free} 个名额一直空着。` : '')
      + `收口测试只挡 close，不挡开树、派发、续派。`);
  }
  process.stdout.write([
    ...out,
    `票数按在飞代理 description 的 \`T<n>·\` 前缀认；某个在跑的代理没按这个前缀写就会被漏数——`
      + `真满了就在回复里说明哪几个代理占着名额，然后结束回合。`
      + `某张够格票确实要等开发者拍板才能开，按 \`freeze.md\` 给它登记冻结面（冻住的票不再算够格）；整体停派才用 Write 写 \`${holdPath}\`。`,
    ...(developerTurn && (named.length || take.length) ? [`**先派发，再处理开发者消息里的其它事**：派发只要几十秒，读材料、调研可以在代理跑着的时候做。`] : []),
    ...(developerTurn ? [`这回合是开发者起的：他明确叫停了派发 → 用 Write 写 \`${holdPath}\`（一行：他叫停了什么），然后结束回合；`
      + `你正在等他回答一个问题 → 不写 hold（hold 会连带关掉名额检查，直到他回话），在回复里一句话说明为什么这回合不派，然后结束回合。`] : []),
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
