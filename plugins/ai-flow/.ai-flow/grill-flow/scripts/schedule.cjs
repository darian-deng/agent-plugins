#!/usr/bin/env node
// grill-flow stage-3「执行单位」判定：一票一树还是一组一车道，按轮数算，不靠感觉。
//
//   node scripts/schedule.cjs [--cap <n>]      # --cap 默认 3，即主循环的批次上限
//
// 存在理由：这个选择此前靠三条主观判据（票多不多、组内串不串、装依赖贵不贵），而实测
// 表明其中两条会把人引向错误答案——
//   - 「装依赖贵」：pnpm store 命中时一次 19 秒，44 票一票一树也就十几分钟，不是瓶颈；
//   - 「组内高度串行」：真正决定一票一树能并到多少的不是依赖关系，而是**写集相交**。
//     两票只要 `Touches` 相交就不能同批，即使彼此没有 `Blocked by`。44 票放开上限到 44，
//     每轮仍只推进 ~2.4 票，因为写集重叠把它们摊到了 18 轮。
// 而车道模式把「写集相交但属于同一模块」的票放进同一棵树**顺序**做（前一票的改动已经在
// 树里，不构成冲突），跨车道并行——于是它反而比一票一树更快。这个结论只能算出来。
//
// 三个数字的含义：
//   - 最长依赖链 = 墙钟下限。再多的并行度也压不到它以下。
//   - 一票一树 N 轮 = 每轮取「够格 ∧ 与本轮已选票写集不相交」的前 cap 张（与主循环同算法，
//     同一份 tickets.md 每次都算出同一结果）。
//   - 一组一车道 N 轮 = 最长那条车道的票数（每轮各车道推进一票）。分组优先读票上的
//     `lane:`；没有就按「`Touches` 相交 ∨ 有 `Blocked by` 关系」取连通分量。
'use strict';

const { existsSync, readFileSync } = require('fs');
const { join } = require('path');

const flowDir = join(__dirname, '..');
const projectRoot = join(flowDir, '..', '..');

const die = (m) => { process.stderr.write('❌  ' + m + '\n'); process.exit(1); };
const say = (m) => process.stdout.write(m + '\n');

let state;
try { state = require(join(flowDir, 'state', 'active.json')); }
catch (e) { die('无法读取 state/active.json: ' + e.message); }
if (!state.flow_id) die('active.json 缺 flow_id');

const ticketsPath = join(projectRoot, 'docs', 'grill-flows', state.flow_id, 'tickets.md');
if (!existsSync(ticketsPath)) die('缺 tickets.md: ' + ticketsPath);

const capIdx = process.argv.indexOf('--cap');
const cap = capIdx !== -1 ? Number(process.argv[capIdx + 1]) : 3;
if (!Number.isInteger(cap) || cap < 1) die('--cap 要是正整数，收到: ' + process.argv[capIdx + 1]);

// ── 解析（块边界与 gate-stage-3 的 qc:done 判定一致：票行 + 其后的缩进子行）──
const lines = readFileSync(ticketsPath, 'utf-8').split('\n');
const tk = new Map();   // T -> { blocked:[], touches:[], lane:null }
const order = [];       // 文件顺序 = 主循环的确定性 tiebreak
let cur = null;
for (const l of lines) {
  const m = /^- \[([ xX])\] (T\d+)/.exec(l);
  if (m) { cur = m[2]; tk.set(cur, { blocked: [], touches: [], lane: null }); order.push(cur); continue; }
  if (cur === null) continue;
  if (/^#{1,6}\s/.test(l)) { cur = null; continue; }
  if (!/^\s+\S/.test(l)) continue;
  const mb = /(?:^|\s)Blocked by:\s*(.+)$/.exec(l);
  if (mb) tk.get(cur).blocked = (mb[1].match(/T\d+/g) || []);
  const mt = /(?:^|\s)Touches:\s*(.+)$/.exec(l);
  if (mt) tk.get(cur).touches = mt[1].split(/[,\s]+/).filter((s) => s.length > 0);
  const ml = /(?:^|\s)lane:\s*(\S+)/.exec(l);
  if (ml) tk.get(cur).lane = ml[1];
}
if (tk.size === 0) die('tickets.md 里没有 ticket 级行（`- [ ] T<n>`）');

// 写集相交：目录前缀也算相交（`src/a/` 与 `src/a/b.ts` 是同一处）。这里只做前缀比较、
// 不展开 glob——判断「能不能同批」时把 `src/*.ts` 与 `src/x.ts` 算作相交是收紧方向。
const norm = (g) => g.replace(/\/+$/, '').replace(/\/\*+$/, '');
const NONE = /^(none|无|-|—)$/i;
function overlap(a, b) {
  if (a.some((x) => NONE.test(x)) || b.some((x) => NONE.test(x))) return true;   // 预估不了 → 只能独占
  for (const x of a) for (const y of b) {
    const nx = norm(x), ny = norm(y);
    if (nx === ny || nx.startsWith(ny + '/') || ny.startsWith(nx + '/')) return true;
  }
  return false;
}

// 最长依赖链
const memo = new Map();
function depth(t) {
  if (memo.has(t)) return memo.get(t);
  memo.set(t, 1);   // 环上的票取 1，环本身由 gate-stage-2 拦，这里只防无限递归
  const d = 1 + Math.max(0, ...tk.get(t).blocked.filter((b) => tk.has(b)).map(depth));
  memo.set(t, d);
  return d;
}
const lowerBound = Math.max(...[...tk.keys()].map(depth));

// 一票一树：与主循环同算法
function roundsPerTicket(k) {
  const done = new Set();
  let r = 0;
  while (done.size < tk.size) {
    const batch = [];
    for (const t of order) {
      if (done.has(t) || batch.includes(t)) continue;
      if (tk.get(t).blocked.some((b) => tk.has(b) && !done.has(b))) continue;
      if (batch.some((o) => overlap(tk.get(t).touches, tk.get(o).touches))) continue;
      batch.push(t);
      if (batch.length >= k) break;
    }
    if (batch.length === 0) return null;   // 依赖成环，算不下去
    batch.forEach((t) => done.add(t));
    r++;
  }
  return r;
}

// 分组：优先用票上已落盘的 lane:，否则按「写集相交 ∨ 有依赖关系」取连通分量
function groups() {
  const declared = [...tk.entries()].filter(([, v]) => v.lane);
  if (declared.length === tk.size) {
    const g = new Map();
    for (const [t, v] of tk) { if (!g.has(v.lane)) g.set(v.lane, []); g.get(v.lane).push(t); }
    return { source: 'tickets.md 的 lane: 字段', groups: g };
  }
  const parent = new Map([...tk.keys()].map((t) => [t, t]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const all = [...tk.keys()];
  for (const t of all) for (const b of tk.get(t).blocked) if (tk.has(b)) union(t, b);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (overlap(tk.get(all[i]).touches, tk.get(all[j]).touches)) union(all[i], all[j]);
    }
  }
  const g = new Map();
  for (const t of all) { const r = find(t); if (!g.has(r)) g.set(r, []); g.get(r).push(t); }
  return { source: '连通分量（Touches 相交 ∨ 有 Blocked by 关系）', groups: g };
}

const { source, groups: gs } = groups();

// ── 走 `lane:` 分支时校验它自己的前提 ──
// `roundsLanes` 在分量 ≤ K 时直接返回「最大车道的票数」，隐含「每轮每条车道各推进一票、
// 零停等」。这个前提只有分组是**连通分量**时才由构造成立（跨分量按定义写集不相交）。
// `lane:` 来自 stage-2 的模块划分，跨车道写集相交是常态——那些票不能同批，于是车道会
// 停等，而脚本把停等当零。实测一次 51 票的 flow：4 组跨车道相交、造成约 173 分钟停等，
// 而脚本报的是「4 条车道 15 轮」。不静默：报不出准确轮数没关系，但不能假装那部分不存在。
if (source.startsWith('tickets.md')) {
  const laneOf = new Map();
  for (const [t, v] of tk) laneOf.set(t, v.lane);
  const pairs = [];
  const all = [...tk.keys()];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (laneOf.get(a) === laneOf.get(b)) continue;          // 同车道串行做，相交是正常的
      if (overlap(tk.get(a).touches, tk.get(b).touches)) pairs.push([a, b]);
    }
  }
  // 没有 `Touches` 的票 `overlap([], x)` 恒 false，会被当成与谁都不相交而静默漏过。
  // stage-2 的门强制每票有 Touches，但**执行期插的票不过那道门**——而本 flow 的背景正是
  // 一次 47→52 张票的运行。
  const noTouches = [...tk.entries()].filter(([, v]) => !v.touches || v.touches.length === 0).map(([t]) => t);
  if (noTouches.length > 0) {
    say(`\n⚠  这些票没有可解析的 Touches，下面的相交计算对它们是盲的（当成与谁都不相交）：`);
    say('   ' + noTouches.join(' ') + '  ← 执行期插的票容易漏，补上再重跑');
  }
  if (pairs.length > 0) {
    // 「跨车道票」：与最多条别的车道相交的那些。它们一开工就挡住别的车道，应当排在
    // 各车道同时空闲的时刻单独跑，而不是在别的车道正跑时插进来。
    const spread = new Map();
    for (const [a, b] of pairs) {
      if (!spread.has(a)) spread.set(a, new Set());
      if (!spread.has(b)) spread.set(b, new Set());
      spread.get(a).add(laneOf.get(b));
      spread.get(b).add(laneOf.get(a));
    }
    const ranked = [...spread.entries()].sort((x, y) => y[1].size - x[1].size).slice(0, 5);
    say(`\n⚠  分组来自 tickets.md 的 lane: 字段，但**跨车道写集相交 ${pairs.length} 对**——`);
    say(`   下面的「一组一车道 N 轮」建立在「每轮各车道各推进一票、零停等」之上，这个前提`);
    say(`   对相交的那些票不成立：它们不能同批，实际轮数会更高。相交对（最多列 8 对）：`);
    say('   ' + pairs.slice(0, 8).map(([a, b]) => `${a}×${b}`).join(' ') + (pairs.length > 8 ? ' …' : ''));
    say(`   跨车道票（开工即挡住别的车道，应排在各车道同时空闲时单独跑）：`);
    for (const [t, lanes] of ranked) say(`     ${t}（${laneOf.get(t)}）与 ${[...lanes].sort().join('、')} 相交`);
  }
}
const parts = [...gs.entries()].map(([k, v]) => ({ name: k, n: v.length })).sort((a, b) => b.n - a.n);

// 车道模式在「K 条车道」下的轮数。两种模式必须在**同一并发预算**下比：一票一树同时跑
// cap 票，车道模式同时跑「车道数」票，子代理峰值是同一量级。不对齐就会得出荒谬结论——
// 票两两不相交时连通分量退化成「每票一个分量」，那 44 条“车道”其实就是一票一树本身。
// 分量多于 K 时按「最大分量优先放进当前最小车道」装箱（贪心，确定性）。
function roundsLanes(k) {
  if (parts.length === 0) return null;
  if (parts.length <= k) return parts[0].n;                   // 分量不足 K 条，各占一条
  const bins = new Array(k).fill(0);
  for (const p of parts) {
    let mi = 0;
    for (let i = 1; i < k; i++) if (bins[i] < bins[mi]) mi = i;
    bins[mi] += p.n;
  }
  return Math.max(...bins);
}

say(`${tk.size} 票 · 最长依赖链 ${lowerBound} 票（墙钟下限，任何并行度都压不到它以下）`);
say(`分组来源：${source} → ${parts.length} 个分量：${parts.map((p) => `${p.name}(${p.n})`).join(' ')}`);
say('');
say('同一并发预算下的两种执行单位（轮数越小越快）：');
say('  并发   一票一树   一组一车道');
const budgets = [...new Set([cap, 3, 4, 6, 8])].filter((k) => k <= Math.max(4, tk.size)).sort((a, b) => a - b);
for (const k of budgets) {
  const a = roundsPerTicket(k);
  const b = roundsLanes(k);
  say(`   ${String(k).padStart(2)}     ${String(a === null ? '—' : a).padStart(4)} 轮    ${String(b === null ? '—' : b).padStart(4)} 轮${k === cap ? '   ← 当前 cap' : ''}`);
}
const satur = roundsPerTicket(tk.size);
if (satur !== null) {
  say('');
  say(`一票一树放开上限到 ${tk.size}（等于不限）→ 仍是 ${satur} 轮。`);
  if (satur > lowerBound) {
    say(`  ↑ 比下限 ${lowerBound} 高出 ${satur - lowerBound} 轮，而且再加并发也不降 —— 瓶颈是**写集相交**，`);
    say(`    不是并行度。这正是车道模式能赢的情形（它把写集相交的票放进同一棵树顺序做）。`);
  }
}
say('');

const a = roundsPerTicket(cap), b = roundsLanes(cap);
if (a === null) {
  say('结论：一票一树算不出轮数（依赖可能成环），先修 tickets.md 的 Blocked by。');
} else if (b !== null && b < a) {
  say(`结论：**一组一车道**，${cap} 条车道 ${b} 轮 < 一票一树 ${a} 轮。`);
  say(`分组照上面那 ${parts.length} 个分量走（多于车道数时按「大分量优先进最空车道」装箱，与本脚本算轮数用的是同一套），落进每票的 \`lane:\`。`);
  say(`⛔ 开跑前先读 references/lane-mode.md：三条代价（机器门⑦ 不生效 → 必须自己记 \`## 已知碰撞面\`；收口测试按轮且有硬上限 → 必须落 \`## 收口记录\`；长驻树的两类假红）里有两条漏做不会有任何东西变红。`);
} else if (b !== null && b > a) {
  say(`结论：**一票一树**（${a} 轮 < 一组一车道 ${b} 轮），而且机器保护更强（多一条机器门⑦）。`);
} else {
  say(`结论：两种模式都是 ${a} 轮 → 选**一票一树**，它多一条机器门⑦。`);
}
process.exit(0);
