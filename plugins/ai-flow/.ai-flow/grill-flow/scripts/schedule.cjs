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

const { existsSync, readFileSync, realpathSync } = require('fs');
const { join, dirname, basename, resolve } = require('path');

const die = (m) => { process.stderr.write('❌  ' + m + '\n'); process.exit(1); };
const say = (m) => process.stdout.write(m + '\n');

// ── flowDir 解析（四级，最后一级响亮地死）──────────────────────────────────
// 本脚本随插件分发、不再住在项目里，所以 `__dirname` 只够回答「我属于哪个 flow」
//（上一级目录名就是 flow 名），回答不了「**哪个项目**在跑我」。
// ⛔ 不许拿 `join(__dirname, '..')` 当 flowDir 兜底：那推出来的是**插件自己的仓库**，
//    于是 state 读写与 git 操作全都静默作用在错误的树上——把「找不到项目」这种一眼可见
//    的失败，换成了「安静地做错事」。所以第四级是死，不是兜底。
const FLOW_NAME = basename(join(__dirname, '..'));
// 解掉符号链接再往下用。`git` 报的路径永远是真实路径（macOS 的 `/var/folders/…` 实为
// `/private/var/folders/…`），基准两边不一致时 `relative()` 会算出一串 `../`，于是
// 「锚点相对」的前缀剥离、残留 worktree 的前缀匹配都**静默失效**。旧版从 `__dirname`
// 取路径时是 node 顺手解的（模块路径默认走 realpath），换成 argv / env / cwd 之后得自己解。
const realDir = (p) => { try { return realpathSync(p); } catch { return p; } };
function resolveFlowDir() {
  // 1) `--flow-dir <abs>`：模型从 Bash 跑时由提示词给（紧跟脚本路径、在子命令之前）。
  //    就地从 argv 取走，后面按位置解析参数的代码才看不见它。
  const i = process.argv.indexOf('--flow-dir');
  if (i !== -1) {
    const v = process.argv[i + 1];
    process.argv.splice(i, v ? 2 : 1);
    if (!v) die('--flow-dir 后面要跟 `<项目>/.ai-flow/' + FLOW_NAME + '` 的绝对路径。');
    return realDir(resolve(v));
  }
  // 2) `AI_FLOW_FLOW_DIR`：引擎跑 gate / 脚本校验时注入。
  if (process.env.AI_FLOW_FLOW_DIR) return realDir(resolve(process.env.AI_FLOW_FLOW_DIR));
  // 3) 从 cwd 逐级上溯。判据是 `state/active.json` 而不是目录存在：没有活跃 flow 的
  //    目录不该被认成锚点（装了 flow 但没启动的项目会把上溯停在错误的一级）。
  let d = process.cwd();
  for (;;) {
    const cand = join(d, '.ai-flow', FLOW_NAME);
    if (existsSync(join(cand, 'state', 'active.json'))) return realDir(cand);
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  // 4) 响亮地死，并打印带正确 `--flow-dir` 的完整命令。
  // 含空格的参数要把引号带回去：`--install "npm ci"` 直接拼回去会变成两个参数，
  // 照抄这条命令的人拿到的就是一条跑不通的命令。
  const rest = process.argv.slice(2).map((a) => (/\s/.test(a) ? JSON.stringify(a) : a));
  die(
    '定位不到项目的 flow 目录（`<项目>/.ai-flow/' + FLOW_NAME + '/`）：没给 --flow-dir、'
    + '没有 AI_FLOW_FLOW_DIR，从 cwd（' + process.cwd() + '）逐级上溯也没找到 `.ai-flow/'
    + FLOW_NAME + '/state/active.json`。\n'
    + '    本脚本住在插件里（' + __filename + '），从自己的位置推不出是哪个项目在跑它——'
    + '硬推只会推到插件自己的仓库，然后静默地对错误的树动手。\n'
    + '    三种补法，任选其一：\n'
    + '    1) 显式给（提示词里就是这个形状）：\n'
    + '       node ' + __filename + ' --flow-dir <项目>/.ai-flow/' + FLOW_NAME
    + (rest.length ? ' ' + rest.join(' ') : '') + '\n'
    + '    2) 设 AI_FLOW_FLOW_DIR=<项目>/.ai-flow/' + FLOW_NAME + '（引擎跑 gate 时自动注入的就是这一条）\n'
    + '    3) 换到项目里跑：cwd 或它的某一级祖先下要有 `.ai-flow/' + FLOW_NAME + '/state/active.json`'
  );
}

// `--help` 必须拦在 flowDir 解析**之前**：解析失败会先死，于是「我想知道怎么用」被答成一条定位失败的报错；不拦又会静默跑完一次全量调度报表（实测一个子代理想看用法，拿到的是一份 25 票的报表）。两种都不是用法。
// 拿到的是一份 25 票的报表）——那不是错误结果，只是把「我想知道怎么用」答成了别的东西。
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(
    '用法（--flow-dir 紧跟脚本路径）:\n'
    + '      node ' + __filename + ' --flow-dir <项目>/.ai-flow/' + FLOW_NAME + ' [--cap <正整数>]\n'
    + '      node ' + __filename + ' --flow-dir <项目>/.ai-flow/' + FLOW_NAME + ' missed [<在飞票号> …]\n'
    + '      node ' + __filename + ' --flow-dir <项目>/.ai-flow/' + FLOW_NAME + ' rm [<票号>]\n'
    + '不带子命令：按主循环同一套准入算法，模拟「一票一树」与「一组一车道」两种执行单位各要几轮，谁少用谁。\n'
    + '--cap 是并发上限，缺省 3。判据与两种模式的代价见 references/execution-unit.md。\n'
    + 'missed：给出当前在飞（已开 worktree）的票号，报「此刻同样够格同批开、却没开」的票。只摆事实，不放行。\n'
    + 'rm：报真机验证三态（`rm:none` / `rm:pending` / `rm:done`）的登记情况。带票号只报那一张，不带报全量分布。\n'
  );
  process.exit(0);
}

const flowDir = resolveFlowDir();
const projectRoot = join(flowDir, '..', '..');

let state;
try { state = require(join(flowDir, 'state', 'active.json')); }
catch (e) { die('无法读取 state/active.json: ' + e.message); }
if (!state.flow_id) die('active.json 缺 flow_id');

const ticketsPath = join(projectRoot, 'docs', 'grill-flows', state.flow_id, 'tickets.md');
if (!existsSync(ticketsPath)) die('缺 tickets.md: ' + ticketsPath);

// ── 子命令分发 ──────────────────────────────────────────────────────────────
// 本脚本原先没有子命令，一跑就是那份全量调度报告。加分发时的硬约束是**不带子命令时逐字
// 不变**（`--cap 6` 这类既有开关照旧走到下面），所以判据只能是「argv[2] 是不是一个不以
// `-` 开头的词」：`--flow-dir <v>` 已经在 resolveFlowDir 里就地 splice 掉了，此刻 argv[2]
// 要么是子命令、要么是 `--cap` 这类开关，两者分得开。
// 未知子命令是死而不是「当没写、照打报告」：`mised` 这种手滑若静默降级成一份 25 票的调度
// 报表，调用方拿到的是一份看起来正常、却答非所问的输出——那比响亮失败难发现得多。
const SUB = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : null;
if (SUB !== null && SUB !== 'missed' && SUB !== 'rm') {
  die('未知子命令: ' + SUB + '（只支持 `missed` / `rm`；不带子命令 = 那份全量调度报告，跑 --help 看用法）');
}

const capIdx = process.argv.indexOf('--cap');
const cap = capIdx !== -1 ? Number(process.argv[capIdx + 1]) : 3;
if (!Number.isInteger(cap) || cap < 1) die('--cap 要是正整数，收到: ' + process.argv[capIdx + 1]);

// ── 解析（块边界与 gate-stage-3 的 qc:done 判定一致：票行 + 其后的缩进子行）──
const lines = readFileSync(ticketsPath, 'utf-8').split('\n');
// `done`：正则一直捕获着勾选状态（`m[1]`），却从没存下来——默认报告只关心「全量要跑几轮」，
// 不关心跑到哪了。`missed` 要的正是「还没勾的里面谁够格」，所以这里把它落进来。
const tk = new Map();   // T -> { blocked:[], touches:[], lane:null, done:bool, rmHits:[] }
const order = [];       // 文件顺序 = 主循环的确定性 tiebreak

// ── 真机验证三态（`rm:none` / `rm:pending` / `rm:done`）───────────────────────
// 约定是每票**有且仅有一个**，所以这里收集**全部**命中、不取第一个：把「一个都没写」
// 和「写了两个」分开报，是 `worktree.cjs close` 那道前置断言能成立的前提——只存一个
// 状态字段的话，两个互相矛盾的标记（`rm:none` 和 `rm:done` 并排）会被静默压成一个，
// 而那正是最该拦的形态。
// 标记可以写在**票行本身**、也可以写在它的缩进子项，两处都扫。
// `\b` 前缀边界挡掉 `arm:pending`、`confirm:done` 这类词中命中；中文字符不算 `\w`，
// 所以「本票 rm:pending」这种紧挨中文的写法照样命中。
const RM_MARK = /\brm:(none|pending|done)\b/g;
function collectRm(rec, line) {
  RM_MARK.lastIndex = 0;   // 全局正则的 lastIndex 会跨调用残留，不清就会漏命中
  let m;
  while ((m = RM_MARK.exec(line)) !== null) rec.rmHits.push({ state: m[1], text: line.trim() });
}

let cur = null;
for (const l of lines) {
  const m = /^- \[([ xX])\] (T\d+)/.exec(l);
  if (m) {
    cur = m[2];
    tk.set(cur, { blocked: [], touches: [], lane: null, done: m[1] !== ' ', rmHits: [] });
    order.push(cur);
    collectRm(tk.get(cur), l);   // 票行内的标记（约定允许写在这里）
    continue;
  }
  if (cur === null) continue;
  if (/^#{1,6}\s/.test(l)) { cur = null; continue; }
  if (!/^\s+\S/.test(l)) continue;
  collectRm(tk.get(cur), l);     // 缩进子项里的标记
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

// ── 子命令 `missed`：报「本可以一起开、却没开」的票 ──────────────────────────
// 存在理由：stage-3 主循环的准入判据（依赖已满足 ∧ 写集与本批已选票不相交）本身没错，
// 错的是**没有任何东西会在开树那一刻把「你还漏了哪几张」摆到主 session 眼前**。实测一条
// 真实 flow：112 个批次里 62 个没装满（空掉 85 个槽位），50 个单票批里 39 个（78%）当时
// 至少还能再加一张够格且写集不相交的票——规则允许 96 轮，实际跑成 112 批。
// 所以这里只做一件事：把够格的票摆出来。⛔ 不自动放行、不改批宽上限、不下「该不该开」的
// 判断——那是主 session 的决定；脚本抢着替它决定，只会把一个可核对的事实换成一条不可核对
// 的指令，而它判错时没有任何人能发现。
if (SUB === 'missed') {
  const args = process.argv.slice(3);
  const ignored = args.filter((a) => !/^T\d+$/.test(a));
  const given = args.filter((a) => /^T\d+$/.test(a));
  const unknown = given.filter((t) => !tk.has(t));
  const live = new Set(given.filter((t) => tk.has(t)));

  // 在飞票写集的**并集**，交给已有的 overlap() 判。⛔ 不要另写一套前缀比较：overlap()
  // 里 `none/无/-/—` 的「预估不了 ⇒ 只能独占」和目录前缀两种语义都是调过的，复制一份
  // 出来迟早和主循环的准入判据分叉——那时两边都说自己对，而谁都不知道哪边在骗人。
  const liveTouches = [...live].flatMap((t) => tk.get(t).touches);
  const done = new Set([...tk.entries()].filter(([, v]) => v.done).map(([t]) => t));

  // ⛔ 贪心选一个**两两不相交**的子集，不是逐票独立判。这一版最初只判了「与在飞票不相交」，
  // 于是两张彼此写集相交的票会被一起列出来，而下面那句话让人把它们一起开出去 —— 照做就是
  // 两棵写集相交的 worktree，rebase 必撞。主循环的准入是「与批内**其它已入选票**也不相交」
  // （`roundsPerTicket` 里那句 `batch.some(...)`），这里必须同口径，否则这条提示在教人违规。
  const eligible = [];
  for (const t of order) {
    if (done.has(t) || live.has(t)) continue;
    // 与主循环同一口径：只看**本 tickets.md 里存在**的前驱。指向别处（已删的票、别的
    // flow）的 Blocked by 永远勾不上，按它挡就等于把票永久冻住。
    if (tk.get(t).blocked.some((b) => tk.has(b) && !done.has(b))) continue;
    // 在飞集合为空时不做相交过滤：没有在飞票就无从相交。判据用 `live.size` 而不是
    // `liveTouches.length` —— 在飞票存在、但它们的 `Touches` 解析不出来（执行期插的票不过
    // stage-2 那道门）时 `liveTouches` 也是空数组，用长度判就会把**所有**票放行，包括
    // `Touches: 无` 的独占票，而主循环那边 `overlap(['无'], [])` 是判它不够格的。
    if (live.size > 0 && overlap(tk.get(t).touches, liveTouches)) continue;
    if (eligible.some((o) => overlap(tk.get(t).touches, tk.get(o).touches))) continue;
    eligible.push(t);
  }

  if (ignored.length > 0) say(`⚠  已忽略非票号参数：${ignored.join(' ')}（missed 后面只认 T<n> 形态的票号）`);
  if (unknown.length > 0) {
    say(`⚠  这些在飞票号在 tickets.md 里找不到：${unknown.join(' ')}`);
    say('   它们的写集进不了下面的相交判断，于是清单会偏宽（可能列出实际会撞车的票）。');
  }
  const noTouch = [...live].filter((t) => tk.get(t).touches.length === 0);
  if (noTouch.length > 0) {
    say(`⚠  这些在飞票在 tickets.md 里没有可解析的 \`Touches\` 行：${noTouch.join(' ')}`);
    say('   它们的写集进不了相交判断，于是清单会偏宽（可能列出实际会撞车的票）。');
  }
  const liveDesc = live.size > 0 ? `${live.size} 张（${[...live].join(' ')}）` : '0 张';
  const CRIT = '未勾 ∧ 全部 Blocked by 已勾 ∧ 写集与在飞票不相交 ∧ 彼此之间也不相交';
  if (eligible.length === 0) {
    // 无遗漏也必须响亮：静默会被读成「脚本没跑」，于是这条判据每轮都要人重新自己想一遍。
    say(`✅ 无遗漏：在飞 ${liveDesc}，tickets.md 里没有别的票此刻够格同批开（${CRIT}）。`);
  } else {
    say(`📋 在飞 ${liveDesc}，另有 ${eligible.length} 张票此刻同样够格同批开（${CRIT}）：`);
    say('   ' + eligible.join(' '));
    // ⛔ 措辞必须是**有条件**的。`open` 每开一棵树都会跑这段，而一批要逐条 open：开第 1 棵
    // 时后两票还没在飞，它们必然出现在这张清单里 —— 把话写成无条件的「要么一并开、要么写
    // 理由」，happy path 上几乎每次都是假警报，而一条常年误报的红线会被训练成直接忽略。
    say('   ⛳ **若本批到此为止**，就在本回合的回复里**逐张**写下不开的理由（一张一句）；');
    say('      还要接着开就直接开，这几张下一次 open 时会自动从清单里消失。');
    say('      ⚠️ 「已达批宽上限」是一条合法理由，照写即可 —— 要的是这一批漏没漏槽位有据可查，');
    say('      不是逼你开满。两样都没有 = 漏了槽位，而漏批在事后是查不出来的。');
  }
  say(`   批宽上限由 stage 提示词定（stage-3 当前是 3），\`missed\` 既不读它也不改它：`
    + `本命令只回答「还有谁够格」，不回答「该不该开」。`);
  process.exit(0);
}

// ── 子命令 `rm`：真机验证三态的登记情况 ──────────────────────────────────────
// 票面约定（stage-3 记账定的）：每票**有且仅有一个**标记，写在票行内或其缩进子项——
//   rm:none    — <一句理由：不涉及真机 / 开发者豁免（谁、何时）>
//   rm:pending
//   rm:done    — <命令与输出>
//
// 存在理由：上一条真实 flow 实测 `rm:pending` 出现 215 次、`rm:done` 0 次——真机验证
// 登记了但一次都没做过。而全流程唯一的真机落点在 stage-4 环节 C，也就是**全部票做完
// 之后**；那次有两张 P0 缺陷就是在机器地板全绿的掩护下漏过去的。所以三态必须能被机器
// 数出来，而不是靠人翻票面。
//
// ⛔ 本命令只报事实、不下判断、不改任何文件：该不该拒绝收口是 `worktree.cjs close` 的事。
//
// ⚠️ **退出码恒为 0**（只要它算得出结论）。缺标记 / 多于一个都是「算出来的结论」，不是
//    脚本故障，所以不能用非零表达——`worktree.cjs` 那边把「子进程非零」一律当成工具坏了
//    而 fail-open 放行，用非零报结论等于让这道门在最该拦的时候静默失效。
if (SUB === 'rm') {
  const args = process.argv.slice(3);
  const ignored = args.filter((a) => !/^T\d+$/.test(a));
  const want = args.filter((a) => /^T\d+$/.test(a));
  if (ignored.length > 0) say(`⚠  已忽略非票号参数：${ignored.join(' ')}（rm 后面只认 T<n> 形态的票号，且最多一个）`);

  // verdict：`none` / `pending` / `done`（恰好一个标记）、`missing`（一个都没有）、
  // `multi`（多于一个）、`unknown`（tickets.md 里没有这张票的 ticket 级行）。
  const verdictOf = (t) => {
    if (!tk.has(t)) return 'unknown';
    const hits = tk.get(t).rmHits;
    if (hits.length === 0) return 'missing';
    if (hits.length > 1) return 'multi';
    return hits[0].state;
  };
  const WHEN = '    三态各自什么时候用：\n'
    + '      rm:none — <一句理由>   不涉及真机（纯逻辑/纯脚本），或开发者已明确豁免（写清谁、何时）\n'
    + '      rm:pending             要真机验、还没验（合法的登记态，不是错误）\n'
    + '      rm:done — <命令与输出> 已经在真机上验过，把命令和看到的输出抄一份在后面';

  if (want.length > 0) {
    const t = want[0];
    if (want.length > 1) say(`⚠  给了多个票号，只报第一个（${t}）：${want.join(' ')}`);
    const v = verdictOf(t);
    if (v === 'unknown') {
      say(`${t}：tickets.md 里找不到它的 ticket 级行（\`- [ ] ${t} …\` / \`- [x] ${t} …\`）。`);
      say(`   票面上没有这张票，也就没有任何地方能放它的真机验证三态标记。`);
    } else if (v === 'missing') {
      say(`${t}：**缺标记** —— 票面上没有 rm:none / rm:pending / rm:done 中的任何一个。`);
      say(WHEN);
    } else if (v === 'multi') {
      say(`${t}：**多于一个标记**（约定是有且仅有一个），命中如下：`);
      for (const h of tk.get(t).rmHits) say(`     rm:${h.state}   ← ${h.text}`);
      say(`   留一个、删掉其余的：两个互相矛盾的标记（比如 rm:none 和 rm:done 并排）之下，`);
      say(`   「这票到底验没验」是读不出来的。`);
    } else {
      say(`${t}：rm:${v}`);
      say(`     ${tk.get(t).rmHits[0].text}`);
      if (v === 'pending') {
        say(`   （\`rm:pending\` 是**合法的登记态**：它只说「要真机验、还没验」。`);
        say(`   真正的收口在 stage-4 环节 C——那时它要么变成 \`rm:done\`，要么由开发者豁免并写进 review.md。）`);
      }
    }
    // ⚠️ 机器可解析行：`worktree.cjs` 的 close 前置断言**只**靠这一行判定，正则是
    //    `/^RM-STATE\s+\S+\s+(\S+)/m`。改前缀、改字段顺序、改 verdict 取值集合，
    //    都必须同步改 `worktree.cjs` 里 close 分支那段——否则那道门要么恒拒、要么静默失效
    //    （它认不出 verdict 时按「工具坏了」处理，一声不响地放行）。
    say(`RM-STATE ${t} ${v}`);
    process.exit(0);
  }

  // 不带票号：全量分布。
  const buckets = { none: [], pending: [], done: [], missing: [], multi: [] };
  for (const t of order) buckets[verdictOf(t)].push(t);
  say(`${tk.size} 票的真机验证三态登记：`);
  say(`  rm:none     ${String(buckets.none.length).padStart(4)} 张   不涉及真机 / 开发者已豁免`);
  say(`  rm:pending  ${String(buckets.pending.length).padStart(4)} 张   要真机验、还没验`);
  say(`  rm:done     ${String(buckets.done.length).padStart(4)} 张   已在真机上验过`);
  say(`  缺标记      ${String(buckets.missing.length).padStart(4)} 张   三态一个都没写`);
  say(`  多于一个    ${String(buckets.multi.length).padStart(4)} 张   写了两个以上，读不出结论`);
  if (buckets.pending.length > 0) {
    say(`仍 rm:pending：${buckets.pending.join(' ')}`);
    say(`   ⚠️ 这些票在 stage-4 环节 C 收口前必须逐张变成 rm:done，或由开发者豁免并写进 review.md。`);
    say(`   实测参照：上一条真实 flow 的 rm:pending 出现 215 次、rm:done 0 次——登记了从没做过。`);
  }
  if (buckets.missing.length > 0) {
    say(`缺标记：${buckets.missing.join(' ')}`);
    say(WHEN);
  }
  if (buckets.multi.length > 0) say(`多于一个：${buckets.multi.join(' ')}（每票留一个）`);
  // 机器可解析行，同上：改它要同步改 `worktree.cjs`（那边目前只读 RM-STATE，
  // 但两行是同一套 verdict 词汇表，分叉了一样会误导）。
  say(`RM-SUMMARY total=${tk.size} none=${buckets.none.length} pending=${buckets.pending.length}`
    + ` done=${buckets.done.length} missing=${buckets.missing.length} multi=${buckets.multi.length}`);
  process.exit(0);
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
    say(`    不是并行度。`);
    // ⚠️ 这句结论以前是无条件跟在上一行后面的，而它的触发条件 `satur > lowerBound` 几乎恒真。
    // 实测两次它都指反了方向：218 票的真实 flow 里车道 217 轮 vs 一票一树 108 轮（差 2 倍），
    // 6 张票都追加同一个汇聚文件的合成场景里两者都是 6 轮——两次都打印了「车道模式能赢」。
    // 机理：汇聚点让所有票两两相交 ⇒ 连通分量退化成 1 个 ⇒ 车道模式变成全串行，
    // 也就是说**写集相交严重到由单个汇聚文件造成时，它恰好是车道模式最不能赢的情形**。
    // 所以这句必须按同一 cap 下两个真实轮数比出来才敢说，不能从「瓶颈是写集相交」推。
    const rt = roundsPerTicket(cap), rl = roundsLanes(cap);
    if (rt !== null && rl !== null && rl < rt) {
      say(`    这种情形车道模式更快（它把写集相交的票放进同一棵树顺序做）——上表 cap=${cap} 处 ${rl} < ${rt} 轮。`);
    } else if (rt !== null && rl !== null && rl > rt) {
      say(`    ⚠️ 但**车道模式在这里明显更差**（上表 cap=${cap} 处 ${rl} 轮 > 一票一树 ${rt} 轮）：`);
      say(`    ${tk.size} 票只分出 ${parts.length} 个连通分量（最大的那个 ${parts[0].n} 票），车道模式于是接近全串行。`);
      say(`    分量少到这个程度 = 相交集中在少数「汇聚点」文件上（一个文件被大量票同时声明）。`);
      say(`    ⛔ 这种情形靠换执行单位、放宽准入都压不下去，真解是把那个汇聚点 prefactor 掉——`);
      say(`    判据与实测数字见 execution-unit.md 的「汇聚点」那节。`);
      // 上面只说了「prefactor 掉那个汇聚点」，不点名的话读者还得自己去 grep 一遍才知道是哪个文件。
      // 声明频次就是答案，而且要分开报：**文件级**高频项是真汇聚点（prefactor 它），**目录级**
      // 高频项是粒度问题（写到文件级）——两者的解法和收益量级完全不同，实测差一个档：
      // 放开真汇聚点省 3.7%，声明粒度做到完美（Touches = 实际改动）也只省 9.3%。
      const freq = new Map();
      for (const v of tk.values()) for (const x of new Set(v.touches.map(norm))) freq.set(x, (freq.get(x) || 0) + 1);
      const top = [...freq.entries()].filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (top.length > 0) {
        say('');
        say('  被最多票声明的路径（相交就是从这里来的）：');
        for (const [path, n] of top) {
          const raw = [...tk.values()].some((v) => v.touches.some((x) => norm(x) === path && x.endsWith('/')));
          const tag = raw
            ? '目录级声明 → 先写到文件级（准入按目录前缀判相交，⑦ 却按实际文件判）'
            : '文件级汇聚点 → prefactor 掉它才是真解';
          const shown = raw ? path + '/' : path;   // norm 剥了尾斜杠，显示时加回去，否则看不出是目录
          say(`    ${String(n).padStart(3)} 票  ${shown}${' '.repeat(Math.max(1, 44 - shown.length))}← ${tag}`);
        }
      }
    } else if (rt !== null && rl !== null) {
      say(`    两种模式在 cap=${cap} 处打平（各 ${rt} 轮），按下面那条结论选。`);
    }
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
