#!/usr/bin/env node
// grill-flow stage-3「执行单位」判定：一票一树还是一组一车道，按轮数算，不靠感觉。
//
//   node scripts/schedule.cjs [--cap <n>]      # --cap 默认 6，即主循环的并发上限
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
//   - 一票一树 N 轮 = 每轮按取票顺序（插票 → 下游链长降序 → 文件顺序，见 priorityOrder）取
//     「够格 ∧ 与本轮已选票写集不相交」的前 cap 张（与主循环同算法，同一份 tickets.md 每次都算出同一结果）。
//   - 一组一车道 N 轮 = 最长那条车道的票数（每轮各车道推进一票）。分组优先读票上的
//     `lane:`；没有就按「`Touches` 相交 ∨ 有 `Blocked by` 关系」取连通分量。
'use strict';

const { existsSync, readFileSync, realpathSync, readdirSync, writeFileSync, renameSync, linkSync, unlinkSync } = require('fs');
const { join, dirname, basename, resolve, relative } = require('path');
const { execFileSync, spawn } = require('child_process');

const die = (m) => { process.stderr.write('❌  ' + m + '\n'); process.exit(1); };
// kill(pid, 0) 只探活不发信号：ESRCH = 进程不在；EPERM = 在（属于别的用户）。负数 = 整个进程组。
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid === 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// 读收口锁：没有 → null；解析不了但 10 秒内刚写过 → 'fresh'（当活着，别抢）；更老的坏文件 → null。
function readLock(p) {
  let raw;
  try { raw = readFileSync(p, 'utf-8'); } catch { return null; }
  try { return JSON.parse(raw); } catch {
    try { return Date.now() - require('fs').statSync(p).mtimeMs < 10_000 ? 'fresh' : null; } catch { return null; }
  }
}
// 收口锁算活着：collect 进程还在，或它起的收口命令进程组还在（collect 被 SIGKILL 时测试照跑）。
function lockAlive(held) {
  return (held.pid > 0 && pidAlive(held.pid)) || (held.pgid > 0 && pidAlive(-held.pgid));
}
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
// 只看 `--` 之前：`collect B1 -- ls -h` 里的 -h 属于收口命令，被这里截走会打印用法、退出码 0，像是跑成功了。
const OWN_ARGS = process.argv.indexOf('--') === -1 ? process.argv : process.argv.slice(0, process.argv.indexOf('--'));
if (OWN_ARGS.includes('--help') || OWN_ARGS.includes('-h')) {
  process.stdout.write(
    '用法（--flow-dir 紧跟脚本路径）:\n'
    + '      node ' + __filename + ' --flow-dir <项目>/.ai-flow/' + FLOW_NAME + ' [--cap <正整数>]\n'
    + '      node ' + __filename + ' --flow-dir <项目>/.ai-flow/' + FLOW_NAME + ' missed [<在飞票号> …]\n'
    + '      node ' + __filename + ' --flow-dir <项目>/.ai-flow/' + FLOW_NAME + ' rm [<票号>]\n'
    + '      node ' + __filename + ' --flow-dir <项目>/.ai-flow/' + FLOW_NAME + ' ticket <票号>\n'
    + '      node ' + __filename + ' --flow-dir <项目>/.ai-flow/' + FLOW_NAME + ' brief <票号> impl|qc|comment\n'
    + '      node ' + __filename + ' --flow-dir <项目>/.ai-flow/' + FLOW_NAME + ' mark <票号> [--done] [--drop <键>]… [<子项>]…\n'
    + '      node ' + __filename + ' --flow-dir <项目>/.ai-flow/' + FLOW_NAME + ' collect <B<n>> -- <收口命令…>\n'
    + '不带子命令：按主循环同一套准入算法，模拟「一票一树」与「一组一车道」两种执行单位各要几轮，谁少用谁。\n'
    + '--cap 是并发上限，缺省 6。判据与两种模式的代价见 references/execution-unit.md。\n'
    + 'missed：给出当前在飞（已开 worktree）的票号，报「此刻同样够格同批开、却没开」的票，按取票顺序（插票 → 下游链长降序 → 文件顺序）排好。只摆事实，不放行。\n'
    + 'ticket T<n>：原样打印该票票块（派发 prompt 里给子代理的就是这条命令，代替内联票面）。\n'
    + 'brief T<n> <段>：打印派发简报（路径 / 回报落盘路径 / 票面 / 交接段 `### 派发纪律` 原文），子代理开工先跑它。\n'
    + 'mark T<n>：给票记账——每个 <子项> 追加成票下一行 `  - <子项>`；--drop <键> 先删掉该键的子项（键照写、精确匹配，如 idle: / qc:done）；--done 把 [ ] 勾成 [x]。\n'
    + 'selfcheck：交接的机械自检（交接段只一份、有 `### 派发纪律`、切读命令的文件与起始图案都在、登记的树目录都在、已勾的票没有残留树），派冷读之前先跑。\n'
    + 'collect B<n> -- <命令>：跑收口测试（命令整条交给 sh -c，退出码原样透传），跑的期间持 `state/collecting.json`，`worktree.cjs close` 见到它就拒绝——收口只挡 close，开树、派发、续派照常。\n'
    + 'rm：报真机验证三态（`rm:none` / `rm:pending` / `rm:done`）的登记情况。带票号只报那一张，不带报全量分布。\n'
  );
  process.exit(0);
}

const flowDir = resolveFlowDir();
const projectRoot = join(flowDir, '..', '..');

// ⚠️ `rm` 子命令下，active.json 读不到 / 缺 flow_id **同样是结论不是故障**（与 tickets.md
// 那一半同理）：`abort` 会删 active.json（`src/lib/commands/abort.ts`），flow 正常跑完它
// 也不在——而那时遗留的 worktree 还在。若照旧 die，`worktree.cjs close` 会把非零当工具坏了
// 而 fail-open，于是「连活跃 flow 都没有」这种最该拦的情形直接合入。⇒ 报成 verdict。
const RM_EARLY = process.argv[2] === 'rm';
let state;
try { state = require(join(flowDir, 'state', 'active.json')); }
catch (e) {
  if (RM_EARLY) {
    say('❌ 无法读取 state/active.json: ' + e.message);
    say('   没有活跃 flow ⇒ 没有台账，也就没有任何票能有真机三态。abort 过、或 flow 已跑完时就是这样。');
    say(`RM-STATE ${process.argv[3] || '?'} noledger`);
    process.exit(0);
  }
  die('无法读取 state/active.json: ' + e.message);
}
if (!state.flow_id) {
  if (RM_EARLY) { say('❌ active.json 缺 flow_id'); say(`RM-STATE ${process.argv[3] || '?'} noledger`); process.exit(0); }
  die('active.json 缺 flow_id');
}

const ticketsPath = join(projectRoot, 'docs', 'grill-flows', state.flow_id, 'tickets.md');
// ── `rm` 子命令的两种「算得出结论」的异常，⛔ 不许 die ──────────────────────────────
// `worktree.cjs close` 把「子进程非零」一律当成**工具坏了**而 fail-open 放行。所以这两种
// 情况一旦 die，最强的那种违规反而最容易过：**整条台账都不在**（= 一张票都没有真机三态）
// 走 fail-open 放行，而「只有这一张票不在台账里」却被 fail-closed 拒——同一类违规，
// 相反结果。⇒ 它们必须作为 verdict 报出去，由 `worktree.cjs` 决定拒还是放。
const RM_ARGV = process.argv[2] === 'rm';
// `--flow-id <id>`：调用方（`worktree.cjs`）告诉我们它要 close 的是哪条 flow。
// 本脚本的台账路径取自 `state/active.json`，而 `worktree.cjs` 的 flow_id 取自 argv，两者
// 可以不一致——关掉上一条 flow 遗留的 worktree 时就是这样。那时读到的是**当前** flow 的
// 台账，若它恰好也有同号票且带标记，这道门会拿错票的证据放行。
const fidIdx = process.argv.indexOf('--flow-id');
const expectFlowId = fidIdx !== -1 ? process.argv[fidIdx + 1] : null;
// ⛔ 无值时响亮地死，别静默降级：`expectFlowId` 落空会让下面那个 `&&` 短路，flow 不匹配
// 检查整条跳过、退回改动之前「拿另一条 flow 的台账判票」的行为，且不报任何警告。
// 一个打错的旗标应该炸，不该把一道门悄悄变没。
if (fidIdx !== -1 && !expectFlowId) die('--flow-id 后面要跟 flow_id');
if (fidIdx !== -1) process.argv.splice(fidIdx, 2);
if (RM_ARGV && expectFlowId && expectFlowId !== state.flow_id) {
  say(`❌ 要 close 的是 flow \`${expectFlowId}\` 的票，而当前活跃 flow 是 \`${state.flow_id}\`。`);
  say('   本脚本的台账路径取自 state/active.json，这时读到的是**另一条 flow** 的 tickets.md，');
  say('   拿它的票去判真机三态就是拿错票的证据。先确认你要关的是哪条 flow 的遗留 worktree。');
  say(`RM-STATE ${process.argv[3] || '?'} flowmismatch`);
  process.exit(0);
}
if (RM_ARGV && !existsSync(ticketsPath)) {
  say('❌ 缺 tickets.md: ' + ticketsPath);
  say('   台账整个不在 ⇒ 没有任何一张票能有真机三态标记。这是结论，不是本脚本跑不起来。');
  say(`RM-STATE ${process.argv[3] || '?'} noledger`);
  process.exit(0);
}
if (!existsSync(ticketsPath)) die('缺 tickets.md: ' + ticketsPath);

// ── 子命令分发 ──────────────────────────────────────────────────────────────
// 本脚本原先没有子命令，一跑就是那份全量调度报告。加分发时的硬约束是**不带子命令时逐字
// 不变**（`--cap 6` 这类既有开关照旧走到下面），所以判据只能是「argv[2] 是不是一个不以
// `-` 开头的词」：`--flow-dir <v>` 已经在 resolveFlowDir 里就地 splice 掉了，此刻 argv[2]
// 要么是子命令、要么是 `--cap` 这类开关，两者分得开。
// 未知子命令是死而不是「当没写、照打报告」：`mised` 这种手滑若静默降级成一份 25 票的调度
// 报表，调用方拿到的是一份看起来正常、却答非所问的输出——那比响亮失败难发现得多。
const SUB = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : null;
if (SUB !== null && !['missed', 'rm', 'ticket', 'brief', 'mark', 'selfcheck', 'collect'].includes(SUB)) {
  die('未知子命令: ' + SUB + '（只支持 `missed` / `rm` / `ticket` / `brief` / `mark` / `selfcheck` / `collect`；不带子命令 = 那份全量调度报告，跑 --help 看用法）');
}

// ── collect：收口测试期间持锁，让 close 等它 ──────────────────────────────────
// 收口在主工作树跑，而 close 的 ff 会改动正在被测的文件（假红 / 假绿）。0.90.0 之前的规则是
// 「收口时暂停补位」，把开树、派发也一起停了：实测 46 次收口后台任务里 40 次期间零派发，
// 合计 181 分钟名额空着，而真正冲突的只有 close。锁只挡 close（`worktree.cjs` 读它）。
// 锁里存本进程 pid：被 SIGKILL 杀掉留下的锁，pid 已死即视为不在，不会把 close 永久卡住。
if (SUB === 'collect') {
  const dd = process.argv.indexOf('--');
  const label = process.argv[3];
  const usage = '用法：collect <B<n>> -- \'<收口命令>\'（`--` 后面只接**一个**参数，整条命令用单引号包起来交给 sh -c；例：collect B74 -- \'pnpm typecheck > $L/tc.log 2>&1; echo tc=$? >> $L/exit.txt\'）';
  if (!label || label === '--' || dd === -1 || dd === process.argv.length - 1) die(usage);
  // 多个参数拼回一条会丢掉原来的引号（`printf '%s\n' 'a b'` 变成别的命令），不猜，直接拒。
  if (process.argv.length - dd - 1 !== 1) die('`--` 后面收到 ' + (process.argv.length - dd - 1) + ' 个参数。' + usage);
  const cmdline = process.argv[dd + 1];
  const lockPath = join(flowDir, 'state', 'collecting.json');
  // 原子抢锁：先写满临时文件、再 link 成锁名（目标已存在就失败），别人永远读不到半截的锁。
  // 已有的锁持有者死了（pid 与进程组都不在）才清掉重抢一次。
  const tmpLock = lockPath + '.' + process.pid + '.tmp';
  const grab = () => {
    try {
      writeFileSync(tmpLock, JSON.stringify({ pid: process.pid, pgid: null, label, started: new Date().toISOString(), cmd: cmdline.slice(0, 300) }) + '\n');
      linkSync(tmpLock, lockPath);
    } finally { try { unlinkSync(tmpLock); } catch { /* 已删 */ } }
  };
  try { grab(); } catch (e) {
    if (e.code !== 'EEXIST') die('写不了收口锁 ' + lockPath + ': ' + e.message + (/EPERM|ENOTSUP|EOPNOTSUPP/.test(e.code || '') ? '（所在文件系统不支持硬链接）' : ''));
    const raw = (() => { try { return readFileSync(lockPath, 'utf-8'); } catch { return ''; } })();
    const held = readLock(lockPath);
    if (held === 'fresh' || (held && lockAlive(held))) die(`收口 ${held && held !== 'fresh' ? held.label : '?'} 已经在跑` + (held && held !== 'fresh' ? `（pid ${held.pid}，起于 ${held.started || '?'}）` : '（锁刚写下）') + '——等它结束再起下一次。');
    // 删之前再核一次内容没变：另一个 collect 可能已经清掉失效锁、抢到了新锁。
    try {
      if ((() => { try { return readFileSync(lockPath, 'utf-8'); } catch { return null; } })() === raw) unlinkSync(lockPath);
      grab();
    } catch (e2) { die('收口锁被别的进程同时抢走了，稍后再起: ' + e2.message); }
  }
  const release = () => {
    try { if (JSON.parse(readFileSync(lockPath, 'utf-8')).pid === process.pid) unlinkSync(lockPath); } catch { /* 已被清掉 */ }
  };
  // 子进程单独成一个进程组，组号写进锁：本进程被 SIGKILL 时测试还在跑，close 查到组还活着照样拒。
  const child = spawn('sh', ['-c', cmdline], { stdio: 'inherit', detached: true });
  try {
    const cur = JSON.parse(readFileSync(lockPath, 'utf-8'));
    writeFileSync(tmpLock, JSON.stringify({ ...cur, pgid: child.pid }) + '\n');
    renameSync(tmpLock, lockPath);   // rename 原子替换：读方看到的要么是旧锁、要么是新锁
  } catch { try { unlinkSync(tmpLock); } catch { /* 没留下 */ } /* 锁已不在：下面照常跑，只是 close 不再被挡 */ }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { try { process.kill(-child.pid, sig); } catch { /* 组已退出 */ } });
  }
  child.on('error', (e) => { release(); die('收口命令起不来: ' + e.message); });
  // 被信号杀掉按 shell 惯例报 128+信号值，别和「测试红了」的 1 混在一起。
  child.on('exit', (code, sig) => { release(); process.exit(code !== null ? code : 128 + (require('os').constants.signals[sig] || 0)); });
  return;
}

const capIdx = process.argv.indexOf('--cap');
const cap = capIdx !== -1 ? Number(process.argv[capIdx + 1]) : 6;
if (!Number.isInteger(cap) || cap < 1) die('--cap 要是正整数，收到: ' + process.argv[capIdx + 1]);

// ── 解析（块边界与 gate-stage-3 的 qc:done 判定一致：票行 + 其后的缩进子行）──
const lines = readFileSync(ticketsPath, 'utf-8').split('\n');
// `done`：正则一直捕获着勾选状态（`m[1]`），却从没存下来——默认报告只关心「全量要跑几轮」，
// 不关心跑到哪了。`missed` 要的正是「还没勾的里面谁够格」，所以这里把它落进来。
const tk = new Map();   // T -> { blocked:[], touches:[], lane:null, done:bool, inserted:bool, rmHits:[] }
const order = [];       // 文件顺序 = 取票顺序的最后一级 tiebreak（前两级见 priorityOrder）

// ── 真机验证三态（`rm:none` / `rm:pending` / `rm:done`）───────────────────────
// 约定是每票**有且仅有一个**，所以这里收集**全部**命中、不取第一个：把「一个都没写」
// 和「写了两个」分开报，是 `worktree.cjs close` 那道前置断言能成立的前提——只存一个
// 状态字段的话，两个互相矛盾的标记（`rm:none` 和 `rm:done` 并排）会被静默压成一个，
// 而那正是最该拦的形态。
// 标记可以写在**票行本身**、也可以写在它的缩进子项，两处都扫——但只认**标记位**：
//   子项：行首 `- rm:<state>`（允许反引号包着）；票行：`T<n>` 之后第一个 `rm:<state>`。
// 原先是全文 `\brm:(none|pending|done)\b` 全局匹配，于是记账叙述里的「→ `rm:pending` → close」
// 「T10 的 `rm:pending` 原话是…」都被数成第二个标记，`close` 报 `multi` 拒收（实测两张票），
// 主 session 只好去改叙述文字来讨好正则。每行最多取一个：一行写两个状态本身就是错，但
// 那应由「两条子项各一个」的形态报出来，而不是叙述里顺带提到的字面。
// `\b` 前缀边界挡掉 `arm:pending`、`confirm:done` 这类词中命中。
const RM_SUBITEM = /^\s*-\s*`?rm:(none|pending|done)\b/;
const RM_INLINE = /\brm:(none|pending|done)\b/;
function collectRm(rec, line, isTicketLine) {
  const m = isTicketLine ? RM_INLINE.exec(line) : RM_SUBITEM.exec(line);
  if (m) rec.rmHits.push({ state: m[1], text: line.trim() });
}

let cur = null;
let blockClosed = false;
for (let li = 0; li < lines.length; li++) {
  const l = lines[li];
  const m = /^- \[([ xX])\] (T\d+)/.exec(l);
  if (m) {
    cur = m[2];
    tk.set(cur, { blocked: [], touches: [], lane: null, done: m[1] !== ' ', inserted: false, idle: null, start: li, end: li, rmHits: [] });
    order.push(cur);
    blockClosed = false;
    collectRm(tk.get(cur), l, true);   // 票行内的标记（约定允许写在这里）
    continue;
  }
  if (cur === null) continue;
  if (/^#{1,6}\s/.test(l)) { cur = null; continue; }
  // `ticket` 子命令打印的范围：票行起、到第一条顶格非票条目之前（解析口径不变，只管打印到哪）。
  if (/^- \S/.test(l)) blockClosed = true;
  else if (l.trim() !== '' && !blockClosed) tk.get(cur).end = li;
  if (!/^\s+\S/.test(l)) continue;
  collectRm(tk.get(cur), l, false);  // 缩进子项里的标记（只认行首 `- rm:`）
  const mb = /(?:^|\s)Blocked by:\s*(.+)$/.exec(l);
  if (mb) tk.get(cur).blocked = (mb[1].match(/T\d+/g) || []);
  const mt = /(?:^|\s)Touches:\s*(.+)$/.exec(l);
  if (mt) tk.get(cur).touches = mt[1].split(/[,\s]+/).filter((s) => s.length > 0);
  const ml = /(?:^|\s)lane:\s*(\S+)/.exec(l);
  if (ml) tk.get(cur).lane = ml[1];
  if (/^\s*-\s*`?inserted:/.test(l)) tk.get(cur).inserted = true;
  const mi = /^\s*-\s*`?idle:\s*(.*)$/.exec(l);
  if (mi) tk.get(cur).idle = mi[1].replace(/`$/, '').trim() || '（未写理由）';
}
if (tk.size === 0) die('tickets.md 里没有 ticket 级行（`- [ ] T<n>`）');

// ── 冻结面（`## 冻结面` 段；references/freeze.md）────────────────────────────────
// 开发者的停令（「切片①真机通过前不开新切片首票」）以前只活在散文里：主循环的够格判定
// 看不见它，`missed` 会把冻着的票列成「够格」，而主 session 把它解读成「整片停摆」——实测
// 一条这样的令让 15 个批次连续单票、frontier 三次清零共等了 12 小时。所以它成了票面字段：
//
//   ## 冻结面
//   - F1 — 解冻: <条件一句话>
//     - paths: src/main/host/ src/main/boot/        # 写集与之相交的票被冻（目录前缀语义同 overlap）
//     - only: T17 T18                                # 可选：只考虑这些票（票级停令用它）
//     - except: T45 T47                              # 可选：这些票不受本条冻结（解冻条件自身的关键路径）
//     - lifted: 2026-09-28                           # 可选：已解冻，本条整段忽略
//
// 判定：frozen(t) = 未勾 ∧ 无 lifted ∧ t∉except ∧ (only 非空 ? t∈only : true)
//                 ∧ (paths 非空 ? t.touches 与 paths 相交 : only 非空)
// ⚠️ 与 overlap() 的一处刻意差别：`Touches: none/无/-` 的票**不**按路径冻（预估不了写集不等于
// 一定撞冻结面；要冻它就写进 only）。overlap() 那边把 none 当「与一切相交」是为了并行安全——
// 收紧方向；这里若照搬，任何非空冻结面都会把所有 none 票冻住，方向反了。
const freeze = [];   // [{ id, lift, paths:[], only:[], except:[], lifted:false, line }]
{
  let inFreeze = false, ent = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,6}\s/.test(l)) { inFreeze = /^##\s/.test(l) && /冻结面/.test(l); ent = null; continue; }
    if (!inFreeze) continue;
    // 顶格 `- F1 — 解冻: …` 开一条；缩进 `- paths: …` 等是它的字段。
    if (/^-\s+\S/.test(l)) {
      const mm = /^-\s+(\S+)\s*(?:[—–-]+\s*)?(.*)$/.exec(l);
      ent = { id: mm[1], lift: (mm[2] || '').replace(/^解冻[:：]\s*/, '').trim(), paths: [], only: [], except: [], lifted: false, line: i + 1 };
      freeze.push(ent);
      continue;
    }
    if (!ent || !/^\s+-\s*/.test(l)) continue;
    const kv = /^\s+-\s*`?(paths|only|except|lifted|解冻)`?\s*[:：]\s*(.*)$/.exec(l);
    if (!kv) continue;
    const vals = kv[2].split(/[,\s]+/).map((x) => x.replace(/`/g, '')).filter(Boolean);
    if (kv[1] === 'paths') ent.paths.push(...vals);
    else if (kv[1] === 'only') ent.only.push(...vals.filter((x) => /^T\d+$/.test(x)));
    else if (kv[1] === 'except') ent.except.push(...vals.filter((x) => /^T\d+$/.test(x)));
    else if (kv[1] === 'lifted') ent.lifted = true;
    else if (kv[1] === '解冻') ent.lift = kv[2].trim();
  }
}
const activeFreeze = freeze.filter((f) => !f.lifted && (f.paths.length > 0 || f.only.length > 0));
function pathsOverlap(touches, paths) {
  const real = touches.filter((x) => !NONE.test(x));
  if (real.length === 0) return false;
  for (const x of real) for (const y of paths) {
    const nx = norm(x), ny = norm(y);
    if (nx === ny || nx.startsWith(ny + '/') || ny.startsWith(nx + '/')) return true;
  }
  return false;
}
/** 冻住 t 的那条冻结面，或 null。 */
function frozenBy(t) {
  const rec = tk.get(t);
  if (!rec || rec.done) return null;
  for (const f of activeFreeze) {
    if (f.except.includes(t)) continue;
    if (f.only.length > 0 && !f.only.includes(t)) continue;
    if (f.paths.length > 0 ? pathsOverlap(rec.touches, f.paths) : f.only.length > 0) return f;
  }
  return null;
}

// ── 生成物（`## 生成物` 段）：不参与写集相交 ─────────────────────────────────────
// 由脚本从源码生成、合入后重跑生成即可复原的文件（反应表快照、生成的类型清单……）。两票并发
// 改它不是真冲突：后合入那票 sync 后重跑生成命令、`--amend` 折回即可。实测一条 150 票的 flow
// 里单个生成物（G5 反应表快照）是卡住并行最多的一个文件，按真实时长模拟放开它
// 省下的墙钟比其余所有粒度改动加起来还多。
//   ## 生成物
//   - scripts/gates/<快照文件> — `<再生成命令>`
// ⛔ 只登记「有快照校验兜底」的文件（生成物与源码不一致时门禁会红）——没有兜底，「后合入者
// 忘了重跑」会静默留下一份过期快照。路径写法同 `Touches`（锚点相对，逐文件，不许目录）。
// 同一份清单 gate-stage-3.cjs 的断言⑦ 也读（两边口径必须一致）。
const generated = new Set();
{
  let inGen = false;
  for (const l of lines) {
    if (/^#{1,6}\s/.test(l)) { inGen = /^##\s/.test(l) && /生成物/.test(l); continue; }
    if (!inGen) continue;
    const mg = /^-\s+`?([^`\s]+)`?/.exec(l);
    if (mg && !mg[1].endsWith('/')) generated.add(mg[1]);
  }
}

// 写集相交：目录前缀也算相交（`src/a/` 与 `src/a/b.ts` 是同一处）。这里只做前缀比较、
// 不展开 glob——判断「能不能同批」时把 `src/*.ts` 与 `src/x.ts` 算作相交是收紧方向。
const norm = (g) => g.replace(/\/+$/, '').replace(/\/\*+$/, '');
const NONE = /^(none|无|-|—)$/i;
function overlap(a0, b0) {
  if (a0.some((x) => NONE.test(x)) || b0.some((x) => NONE.test(x))) return true;   // 预估不了 → 只能独占
  const a = a0.filter((x) => !generated.has(x)), b = b0.filter((x) => !generated.has(x));
  for (const x of a) for (const y of b) {
    const nx = norm(x), ny = norm(y);
    if (nx === ny || nx.startsWith(ny + '/') || ny.startsWith(nx + '/')) return true;
  }
  return false;
}

// ── 取票顺序：执行期插票 → 下游依赖链长降序 → 文件顺序 ─────────────────────────
// 存在理由：原来只按文件顺序贪心。实测一条 179 票的 flow 剩 40 张时，剩余最长依赖链
// T136→T148→T129→T130→T131 的链头早就够格，却被文件里更靠前、写集与它相交的一张票挡住——
// 链上的票只能一张接一张做，链头越晚开，整个 stage 的拖尾就越长。本脚本对那 40 张的模拟：
// cap 4 从 20 轮降到 13 轮、cap 3 从 22 降到 15；按滚动补位 + 随机工时（lognormal / pareto
// 重尾、工时与写集大小相关）各 300 次，墙钟均值省 10–18%，62 票与 179 票的历史 flow 全量
// 省 5–23%，11–25 票的小 flow ≈0。均值恒为正，但单次可能更慢（重尾下最差 -29%）。
// 第一级留给带 `inserted:` 的执行期插票：只按链长排，名额满时插进来的链尾票要排在全部
// 链上票之后（同一份 40 票模拟里等待均值从 0.11 升到 0.69 个单票工时），而它优先的理由——
// 发现它的 session 上下文还在——正是 mid-flight-ticket.md 要保住的。
// ⛔ 仍是确定性排序：/clear 重入算得出同一顺序，所以「顺序不是决策」这条不变。
function downstreamOf(included) {
  const succ = new Map();
  for (const t of included) succ.set(t, []);
  for (const t of included) for (const b of tk.get(t).blocked) if (succ.has(b)) succ.get(b).push(t);
  const memo = new Map();
  const down = (t) => {
    if (memo.has(t)) return memo.get(t);
    memo.set(t, 0);   // 先置值再递归：真实台账里出现过依赖环，不防就是栈溢出，missed 与 stop-guard 一起崩
    const d = Math.max(0, ...succ.get(t).map((s) => 1 + down(s)));
    memo.set(t, d);
    return d;
  };
  for (const t of included) down(t);
  return memo;
}
function priorityOrder(included) {
  const down = downstreamOf(included);
  const idx = new Map(order.map((t, i) => [t, i]));
  const ranked = order.filter((t) => included.has(t)).sort((x, y) =>
    (Number(tk.get(y).inserted) - Number(tk.get(x).inserted))
    || (down.get(y) - down.get(x))
    || (idx.get(x) - idx.get(y)));
  return { ranked, down };
}

// ── 子命令 `ticket`：原样打印一张票的票块（票行 + 其后的缩进子项）───────────────────
// 存在理由：派发 prompt 原先整段内联票面，同一段文字每票进主 session 上下文三次（主 session
// 读一次、实施与质量链 prompt 各抄一次），此后每轮重新计费。改成 prompt 里只给这条命令、子代理
// 自己跑：主 session 仍读一次（它要据此写派发要点），省掉的是两次抄写；而且子代理拿到的永远是
// 主 session 最后一次改过的版本（补过的 Touches、改过的 AC、写过的 rest:），不会有快照过期。
// ⛔ 不给 tickets.md 路径的规矩不变：这条命令只吐一张票，整份台账（实测 1.7MB）进不了子代理。
if (SUB === 'ticket') {
  const want = process.argv.slice(3).filter((a) => /^T\d+$/.test(a));
  if (want.length !== 1) die('用法：ticket T<n>（恰好一个票号）');
  const t = tk.get(want[0]);
  if (!t) die(`tickets.md 里找不到 ${want[0]} 的票行（\`- [ ] ${want[0]} …\`）`);
  say(lines.slice(t.start, t.end + 1).join('\n'));
  process.exit(0);
}

// ── 子命令 `brief`：一份派发简报，子代理开工先跑它 ─────────────────────────────
// 存在理由：派发 prompt 里大半是机械拼装——四个绝对路径、回报落盘路径、票面命令、以及
// 交接段那份项目派发纪律。实测一个 42 分钟的主 session 派了 25 次，prompt 合计 6.5 万字符，
// 光「边界纪律」一段就 2.6 万：同一份纪律每派一次就经主 session 抄一遍、进它的上下文一遍，
// 而且是有损抄写（交接段原文 9.3K，prompt 里平均只剩 1.5K，17 份出现 8 种版本）。
// 改成脚本现切现给：主 session 的 prompt 只剩「跑这条命令」+ 它自己裁过的补充；纪律只有
// 交接段那一份，不另存副本（handoff.md 禁第二份交接源的理由同样适用）。
// ⛔ 这里只拼机械部分。形态甲/乙/丙、前置票结论、已订正项这些要判断的，仍由主 session 写进 prompt。
if (SUB === 'brief') {
  const t = process.argv[3];
  const seg = process.argv[4];
  if (!/^[TS]\d+$/.test(t || '') || !['impl', 'qc', 'comment'].includes(seg)) die('用法：brief T<n>|S<n> impl|qc|comment');
  // S<n> = 旁路修复（side-fix.md）：有自己的树、走同一套实施 / 质量链，但不在台账里立票。
  const side = t.startsWith('S');
  const rec = side ? null : tk.get(t);
  if (!side && !rec) die(`tickets.md 里找不到 ${t} 的票行`);
  const git = (cwd, ...a) => { try { return execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  // 树的登记名：一票一树 / 旁路是 `<flow_id>-<票号>`；车道模式下票没有自己的树，住在票面
  // `wip: R<n>`（派发前写的在飞标记）或 `lane: R<n>` 指的那条车道里。
  const regOf = (name) => { try { return JSON.parse(readFileSync(join(flowDir, 'state', 'worktrees', `${state.flow_id}-${name}.json`), 'utf-8')).path || null; } catch { return null; } };
  let wtRoot = regOf(t);
  let laneName = null;
  if (!wtRoot && rec) {
    // 只认行首的 `- wip:` 子项（同 RM_SUBITEM 的口径）：票块里的备注常会提到别的车道。
    const wipLine = lines.slice(rec.start + 1, rec.end + 1).map((l) => /^\s+-\s*`?wip:\s*`?(R\d+)/.exec(l)).find(Boolean);
    laneName = (wipLine || [])[1] || (rec.lane && /^R\d+$/.test(rec.lane) ? rec.lane : null);
    if (laneName) wtRoot = regOf(laneName);
  }
  const top = git(projectRoot, 'rev-parse', '--show-toplevel');
  const sub = top ? relative(real(top), real(projectRoot)) : '';
  const wt = wtRoot ? (sub ? join(wtRoot, sub) : wtRoot) : null;
  const FD = resolve(__dirname, '..');
  const reports = join(flowDir, 'state', 'reports');
  let files = [];
  try { files = readdirSync(reports); } catch { /* 还没有 */ }
  const rounds = (kind) => files.map((f) => new RegExp(`^${t}\\.${kind}-(\\d+)\\.md$`).exec(f)).filter(Boolean)
    .map((m) => Number(m[1])).sort((a, b) => a - b);
  const out = [`# ${t} · ${{ impl: '实施', qc: '质量链', comment: '注释清理' }[seg]} 派发简报（schedule.cjs brief 生成；主 session 补的要点在派发 prompt 里）`, '', '## 路径（全部绝对路径）'];
  out.push(wt ? `- <WT>（项目根，与票面 Touches 同基准）= ${wt}` + (laneName ? `（车道 ${laneName}）` : '')
    : `- <WT> = ⚠️ 找不到 ${t} 的工作树（state/worktrees 里没有 ${t}` + (laneName ? `、也没有车道 ${laneName}` : side ? '' : '，票面也没写 `wip: R<n>`') + ' 的登记）——先停下回报主 session，别在别处动手');
  if (wtRoot && sub) out.push(`- <WT_ROOT>（worktree 根）= ${wtRoot}`);
  out.push(`- <FD>（定义层）= ${FD}`, `- <FR>（flow 实例，state/ 在这儿）= ${flowDir}`, `- flow_id = ${state.flow_id}`);
  if (seg === 'comment' && wt) out.push(`- 本票当前 commit = ${git(wt, 'rev-parse', 'HEAD') || '（取不到）'}`);
  const impl = rounds('impl');
  if (seg === 'impl') out.push('', '## 你的回报全文落盘路径', `${join(reports, `${t}.impl-${(impl.at(-1) || 0) + 1}.md`)}（⛔ 不许覆盖已有轮次）`);
  if (seg === 'qc') {
    out.push('', '## 本票实施回报全文（按轮次）', ...(impl.length ? impl.map((k) => `- ${join(reports, `${t}.impl-${k}.md`)}`) : ['- ⚠️ 没找到——先停下回报主 session']));
    out.push('', '## 你的回报全文落盘路径', `${join(reports, `${t}.qc-${(rounds('qc').at(-1) || 0) + 1}.md`)}（⛔ 不许覆盖已有轮次）`);
  }
  out.push('', '## 票面', side ? '（旁路修复不在台账里立票：要修什么、判据是什么，看派发 prompt）' : lines.slice(rec.start, rec.end + 1).join('\n'));
  // 交接段里的 `### 派发纪律` 小节，原文照给（handoff.md 第 ⑥ 格）。
  const hs = lines.findIndex((l) => /^##\s+🔴\s*重入交接/.test(l));
  let ds = -1;
  if (hs !== -1) for (let i = hs + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) if (/^###\s+派发纪律/.test(lines[i])) { ds = i; break; }
  if (ds === -1) {
    out.push('', '## 项目派发纪律', '⚠️ 交接段里没有 `### 派发纪律` 小节。主 session 须把本项目的边界纪律补进 prompt，并尽快在交接段补上这一节。');
  } else {
    let de = ds + 1;
    while (de < lines.length && !/^#{2,3}\s/.test(lines[de])) de++;
    out.push('', '## 项目派发纪律（交接段原文，逐条遵守，与你的代理定义同等效力）', ...lines.slice(ds + 1, de));
  }
  say(out.join('\n').replace(/\n{3,}/g, '\n\n'));
  process.exit(0);
}

// ── 子命令 `mark`：给票记账 ───────────────────────────────────────────────────
// 存在理由：记账（batch: / with: / impl:done / cm:done / qc-metrics / qc:done / 勾选）原先每次由
// 主 session 现写一段 python heredoc 改 tickets.md——实测一个 42 分钟的 session 写了 26 次，
// 命令文本 3.3 万字符、输出 1.9 万，全进主 session 上下文。操作只有三种：追加子项、删掉某键、勾选。
if (SUB === 'mark') (() => {
  const args = process.argv.slice(3);
  const t = args.shift();
  if (!/^T\d+$/.test(t || '')) die('用法：mark T<n> [--done] [--drop <键>]… [<子项>]…');
  const rec = tk.get(t);
  if (!rec) die(`tickets.md 里找不到 ${t} 的票行`);
  let done = false;
  const drops = [];
  const adds = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--done') done = true;
    else if (args[i] === '--drop') { if (!args[i + 1]) die('--drop 后面要跟键名，如 --drop idle:'); drops.push(args[++i]); }
    else adds.push(args[i]);
  }
  if (!done && drops.length === 0 && adds.length === 0) die('mark 至少要有一个 <子项>、--drop 或 --done');
  // 并发的两条 mark 各自「读全文 → 改 → 写回」会互相覆盖：先拿一把排他锁，再重读文件。
  const lockPath = ticketsPath + '.lock';
  const { openSync, closeSync, unlinkSync, statSync } = require('fs');
  let fd = null;
  for (let i = 0; i < 100 && fd === null; i++) {
    try { fd = openSync(lockPath, 'wx'); }
    catch (e) {
      if (e.code !== 'EEXIST') die(`建不了锁文件 ${lockPath}：${e.message}`);
      // 锁超过 30 秒 = 持有者已经死了（mark 本身是毫秒级），收走它。
      try { if (Date.now() - statSync(lockPath).mtimeMs > 30_000) unlinkSync(lockPath); } catch { /* 刚被释放 */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  if (fd === null) die('tickets.md 正被另一条 mark 占着（5 秒没等到锁）——稍后重跑');
  try {
    const L = readFileSync(ticketsPath, 'utf-8').split('\n');
    // 票块口径与上面的解析、gate-stage-3.cjs 一致：票行起，到下一条顶格条目或标题为止，中间
    // 空行不断块；插入点是块里最后一条非空行之后。
    const start = L.findIndex((l) => new RegExp(`^- \\[[ xX]\\] ${t}\\b`).test(l));
    // 不能 die：process.exit 会跳过 finally、把锁留下。
    if (start === -1) { process.stderr.write(`❌  tickets.md 里找不到 ${t} 的票行（锁内重读时已不在）\n`); process.exitCode = 1; return; }
    let last = start;
    for (let i = start + 1; i < L.length; i++) {
      if (/^- \S/.test(L[i]) || /^#{1,6}\s/.test(L[i])) break;
      if (L[i].trim() !== '') last = i;
    }
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 按「键」精确匹配，不按前缀：`--drop qc` 不能顺手删掉 `qc-metrics` / `qc:done`。
    // 键不带冒号时，后面也不许跟冒号：`qc` 只匹配子项 `qc`，不匹配 `qc:done`。
    const dropRe = drops.map((k) => new RegExp('^\\s+-\\s*`?' + esc(k) + (k.endsWith(':') ? '' : '(?=$|[\\s`—])')));
    const body = L.slice(start + 1, last + 1).filter((l) => !dropRe.some((r) => r.test(l)));
    const removed = (last - start) - body.length;
    // 键漏了冒号（`--drop idle`，子项实际是 `- idle: …`）时只提示、不代补：自动补冒号会让
    // `--drop qc` 变成 `qc:`、顺手删掉 `qc:done`——那正是精确匹配要挡的形态。
    const hints = removed ? [] : drops.filter((k) => !k.endsWith(':')).filter((k) => {
      const r = new RegExp('^\\s+-\\s*`?' + esc(k) + ':(?=$|[\\s`—])');
      return L.slice(start + 1, last + 1).some((l) => r.test(l));
    });
    for (const a of adds) body.push('  - ' + a.replace(/\n+/g, ' '));
    if (done) L[start] = L[start].replace(/^- \[ \]/, '- [x]');
    L.splice(start + 1, last - start, ...body);
    const tmp = ticketsPath + '.' + process.pid + '.tmp';
    writeFileSync(tmp, L.join('\n'));
    renameSync(tmp, ticketsPath);
    say(`✅ ${t}：+${adds.length} 条` + (removed ? `，删 ${removed} 条（${drops.join(' ')}）` : '') + (done ? '，已勾选' : ''));
    // 记下一段交付的那一刻就说下一段是什么：实测一次质量链回来 5 分钟后才派注释清理、
    // 解除 idle 4 分钟后才续派——中间主 session 在串行做 close / 记账 / 落决策。
    const key = (a) => a.replace(/^`/, '').split(/[\s—`]/)[0];
    if (adds.some((a) => key(a) === 'impl:done')) say(`→ 下一段：派质量链（prompt 第一段 \`node ${__filename} --flow-dir ${flowDir} brief ${t} qc\`），先派再做别的。`);
    if (adds.some((a) => key(a) === 'cm:done')) say(`→ 下一段：close ${t}（单独一条命令；收口在跑时会被拒，等它结束）。`);
    if (drops.includes('idle:') && removed) say(`→ ${t} 解除闲置：按票面相位续派（无 impl:done → 实施；有 → 质量链），先派再做别的。`);
    if (drops.length && !removed) {
      say(`⚠️ --drop ${drops.join(' ')} 一条都没删到：票块里没有这个键的子项（写在票行本身的不算；键要照写，带冒号的如 \`idle:\`）——核对一下键名。`
        + (hints.length ? `票块里有 ${hints.map((k) => `\`${k}:\``).join(' ')} 子项，要删它就重跑 \`mark ${t} ${hints.map((k) => `--drop ${k}:`).join(' ')}\`。` : ''));
    }
  } finally {
    closeSync(fd);
    try { unlinkSync(lockPath); } catch { /* 已被收走 */ }
  }
})();
if (SUB === 'mark') process.exit(process.exitCode || 0);

// ── 子命令 `selfcheck`：交接的机械自检，派冷读之前先跑 ────────────────────────
// 存在理由：冷读要一个 fresh-context 子代理跑 5–6 分钟，而它报回来的问题里有一类是机械的——
// 实测一次冷读报 9 条，其中「交接段写了两棵实际不存在的树」这种，脚本几秒就能查出来。先把
// 这类清掉，冷读只剩语义问题，改一轮就够。只报不改；有问题退出码 1。
if (SUB === 'selfcheck') {
  const problems = [];
  const hs = lines.map((l, i) => [l, i]).filter(([l]) => /^##\s+🔴\s+重入交接\s*$/.test(l));
  if (hs.length !== 1) problems.push(`\`## 🔴 重入交接\` 有 ${hs.length} 份（只许一份）`);
  const hStart = hs.length ? hs[0][1] : -1;
  let hEnd = lines.length;
  if (hStart !== -1) for (let i = hStart + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { hEnd = i; break; }
  const section = hStart === -1 ? [] : lines.slice(hStart, hEnd);
  if (hStart !== -1 && !section.some((l) => /^###\s+派发纪律/.test(l))) problems.push('交接段里没有 `### 派发纪律` 小节（`brief` 靠它把纪律切给子代理）');
  // 把「收口挡 close」写成「收口挡补位」：新 session 照做，开场名额空着等收口（实测一次 14 分钟才打满）。
  // 冷读查可读性、命令能不能跑，查不出这种串行化，所以机器扫一遍字面。
  // 每种写法都要求同一分句里出现收口 / 回归（不含「回归用例」「修回归」），批号 B<n> 还得带跑完 / 判绿 / 收口字样
  // （票标题里的阶段号也叫 B<n>）；动作只认补位、派、开树 / 开 T<n>（「开始」「开发者」不算）。
  const C = '(?:收口|(?<!修)回归(?!用例|测试))';
  const B = '(?<![A-Za-z])B\\d+';
  const K = '[^。；，,\\n]';
  const ACT = '(?:补位|派|开(?:新?树|\\s*T\\d+))';
  const serial = new RegExp([
    '暂停补位',
    `${C}${K}{0,12}(?:跑完|判绿|结束|完成|完|之后|以后|后)${K}{0,6}(?:才能|才|再)${ACT}`,
    `${B}${K}{0,6}(?:判绿|收口完?)${K}{0,6}(?:才能|才|再)${ACT}`,
    // 批号 +「跑完」只配「补位」：票标题里的阶段号常写「B12 登录页票跑完才能开 T13」，那是票间依赖。
    `${B}${K}{0,6}跑完${K}{0,6}(?:才能|才|再)补位`,
    `${B}${K}{0,6}跑完${K}{0,3}前${K}{0,3}(?:不|别)${K}{0,3}补位`,
    `(?:${C}|${B}${K}{0,6}判绿)${K}{0,12}前${K}{0,3}(?:不|别|勿|⛔)${K}{0,3}${ACT}`,
    `等\\s*[^。；\\n]{0,10}(?:${C}|${B})[^。；\\n]{0,10}(?:再|才)${ACT}`,
    `(?:补位|开新树|开树|派发)[^。；\\n]{0,10}等\\s*(?:${C}|${B})`,
    `${C}(?:期间|在跑|跑着|时)${K}{0,4}(?:不|别|暂停)${K}{0,3}${ACT}`,
  ].join('|'));
  // 字面启发式，只提醒、不挡冷读（不进 problems）：否定句「补位不用等收口」、引用旧写法当反例都会长得像，
  // 拿退出码 1 去挡它，误报的代价是整个交接卡住。命中前 6 字内有否定词、或命中落在「」引号里的放过。
  const warnings = [];
  section.forEach((l, i) => {
    const m = serial.exec(l);
    if (!m) return;
    if (/不用|无需|不必|不需要|别等|不要等/.test(l.slice(Math.max(0, m.index - 6), m.index + m[0].length))) return;
    const before = l.slice(0, m.index);
    if ((before.split('「').length - before.split('」').length) > 0) return;
    warnings.push(`第 ${hStart + i + 1} 行像是把收口 / 回归写成了补位的前置：「…${l.slice(Math.max(0, m.index - 20), m.index + m[0].length + 10)}…」——收口只挡 close，开树、派发、续派照常；真有别的依赖就写出后者碰了前者的什么，误报就不用管`);
  });
  // 切读命令：文件在不在、起始图案有没有命中（read-section 零命中会退出 1，这里提前报）。
  // 交接段自己会定义产物目录的简写（实测写的是 `<产物>`，handoff.md 用 `<产物目录>`），两种都认。
  const artifactDir = join('docs', 'grill-flows', state.flow_id);
  let checked = 0;
  const skipped = [];
  for (const l of section) {
    // 图案用 shell 单引号；`'\''` 是单引号内嵌单引号的写法，先还原再匹配。
    for (const m of l.matchAll(/read-section\.cjs\s+(?:--flow-dir\s+\S+\s+)?(\S+)\s+'((?:[^']|'\\'')+)'/g)) {
      const rel = m[1].replace(/`/g, '').replace(/<产物(?:目录)?>\/?/, artifactDir + '/');
      if (/[<>]/.test(rel)) { skipped.push(rel); continue; }   // 还带别的占位符（<FR> 等）不猜，但要报出来
      checked++;
      m[2] = m[2].replace(/'\\''/g, "'");
      const abs = rel.startsWith('/') ? rel : join(projectRoot, rel);
      if (!existsSync(abs)) { problems.push(`切读命令指向的文件不存在：${rel}`); continue; }
      let re;
      try { re = new RegExp(m[2], 'm'); } catch { problems.push(`切读命令的起始图案不是合法正则：${m[2]}`); continue; }
      if (!re.test(readFileSync(abs, 'utf-8'))) problems.push(`切读命令零命中：${rel} '${m[2]}'`);
    }
  }
  // 登记的树：目录要在；已勾的票不该还开着树（close 会删登记）。
  const reg = join(flowDir, 'state', 'worktrees');
  let regFiles = [];
  try { regFiles = readdirSync(reg).filter((f) => f.startsWith(state.flow_id + '-') && f.endsWith('.json')); } catch { /* 没开过树 */ }
  for (const f of regFiles) {
    const name = f.slice(state.flow_id.length + 1, -5);
    let p = null;
    try { p = JSON.parse(readFileSync(join(reg, f), 'utf-8')).path || null; } catch { /* 半截 */ }
    if (p && !existsSync(p)) problems.push(`${name}：登记在、树目录已不在（${p}）——删掉 state/worktrees/${f}，交接段别写它开着`);
    else if (tk.get(name)?.done) problems.push(`${name}：票已勾选，树却还开着——漏了 close？`);
  }
  if (checked === 0 && hStart !== -1) problems.push('交接段里一条切读命令都没查到（入场表每格应给 `read-section.cjs` 命令；若用了别的占位符，写成 `<产物>`）');
  const warnOut = () => { if (warnings.length) { say(`⚠️ ${warnings.length} 处疑似串行化写法（提醒，不影响退出码）：`); for (const x of warnings) say('  - ' + x); } };
  if (problems.length) {
    say(`❌ 交接机械自检：${problems.length} 处问题（修完再派冷读）；切读命令查了 ${checked} 条` + (skipped.length ? `、${skipped.length} 条带未知占位符没查` : ''));
    for (const x of problems) say('  - ' + x);
    warnOut();
    process.exit(1);
  }
  say(`✅ 交接机械自检通过：交接段一份、有派发纪律、登记的树都在；切读命令查了 ${checked} 条全部命中`
    + (skipped.length ? `，另有 ${skipped.length} 条带未知占位符没查（${[...new Set(skipped)].join(' ')}）` : '') + '。语义问题交给冷读。');
  warnOut();
  process.exit(0);
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
  // `--json`：给脚本（stop-guard.cjs）用的机器可读形态，人读的报告在下面。
  const jsonIdx = process.argv.indexOf('--json');
  const asJson = jsonIdx !== -1;
  if (asJson) process.argv.splice(jsonIdx, 1);
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
  const frozen = [];   // [{ t, f }]
  // 下游链长只数未勾票：已勾的前驱不再挡人，已勾的后继不再等人。
  const { ranked, down } = priorityOrder(new Set(order.filter((t) => !done.has(t))));
  for (const t of ranked) {
    if (live.has(t)) continue;
    // 冻结面先于一切：被冻的票连「够格」两个字都不该出现在它旁边——上一版把它们列成够格，
    // 主 session 就得每轮自己记着「这几张其实不能开」，而那正是散文冻结令的失败形态。
    const fz = frozenBy(t);
    if (fz) { frozen.push({ t, f: fz }); continue; }
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

  if (asJson) {
    const open = order.filter((t) => !done.has(t));
    say(JSON.stringify({
      live: [...live], idle: [...live].filter((t) => tk.get(t).idle), eligible, down: Object.fromEntries(eligible.map((t) => [t, down.get(t)])), frozen: frozen.map((x) => x.t),
      freeze: activeFreeze.map((f) => ({ id: f.id, lift: f.lift, paths: f.paths, only: f.only, except: f.except, count: frozen.filter((x) => x.f === f).length })),
      open: open.length, done: done.size, total: order.length, cap,
    }));
    process.exit(0);
  }
  if (frozen.length > 0) {
    for (const f of activeFreeze) {
      const mine = frozen.filter((x) => x.f === f).map((x) => x.t);
      if (mine.length === 0) continue;
      say(`❄️  冻结面 ${f.id}（解冻: ${f.lift || '（未写解冻条件——补上，否则没人知道什么时候能开）'}）冻住 ${mine.length} 张：${mine.join(' ')}`);
    }
    say('   这些票**不算够格**，下面的清单已经排除它们。解冻条件满足 → 在那条冻结面下加 `- lifted: <日期>`。');
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
  const idleLive = [...live].filter((t) => tk.get(t).idle);
  const liveDesc = live.size > 0 ? `${live.size} 张（${[...live].join(' ')}）` : '0 张';
  if (idleLive.length > 0) {
    say(`💤 其中闲置树 ${idleLive.length} 棵（票面有 \`idle:\`，不占名额、写集照样参与相交）：`
      + idleLive.map((t) => `${t}（${tk.get(t).idle}）`).join('；'));
    if (idleLive.length > 2) say('   ⚠️ 闲置树超过 2 棵：它们的写集一直挡着别的票、基线越放越旧——停下补票面，写 hold 让开发者裁（拆票 / 改依赖）。');
  }
  const CRIT = '未勾 ∧ 全部 Blocked by 已勾 ∧ 写集与在飞票不相交 ∧ 彼此之间也不相交';
  if (eligible.length === 0) {
    // 无遗漏也必须响亮：静默会被读成「脚本没跑」，于是这条判据每轮都要人重新自己想一遍。
    say(`✅ 无遗漏：在飞 ${liveDesc}，tickets.md 里没有别的票此刻够格同批开（${CRIT}）。`);
  } else {
    say(`📋 在飞 ${liveDesc}，另有 ${eligible.length} 张票此刻同样够格同批开（${CRIT}）：`);
    say('   ' + eligible.map((t) => `${t}${tk.get(t).inserted ? '(插)' : ''}(↓${down.get(t)})`).join(' '));
    say('   ↑ 已按取票顺序排好：带 `inserted:` 的执行期插票在前 → 下游依赖链长（↓，后面还串着几张）降序 → 文件顺序。');
    say('     名额不够时**从左往右取**，⛔ 别按文件顺序或凭感觉挑。');
    // ⛔ 措辞必须是**有条件**的。`open` 每开一棵树都会跑这段，而一批要逐条 open：开第 1 棵
    // 时后两票还没在飞，它们必然出现在这张清单里 —— 把话写成无条件的「要么一并开、要么写
    // 理由」，happy path 上几乎每次都是假警报，而一条常年误报的红线会被训练成直接忽略。
    say('   ⛳ **若本批到此为止**，就在本回合的回复里**逐张**写下不开的理由（一张一句）；');
    say('      还要接着开就直接开，这几张下一次 open 时会自动从清单里消失。');
    say('      ⚠️ 「已达批宽上限」是一条合法理由，照写即可 —— 要的是这一批漏没漏槽位有据可查，');
    say('      不是逼你开满。两样都没有 = 漏了槽位，而漏批在事后是查不出来的。');
  }
  say(`   并发上限由 stage 提示词定（stage-3 当前是 6），\`missed\` 既不读它也不改它：`
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
const fullRanked = priorityOrder(new Set(tk.keys())).ranked;
function roundsPerTicket(k) {
  const done = new Set();
  let r = 0;
  while (done.size < tk.size) {
    const batch = [];
    for (const t of fullRanked) {
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
if (activeFreeze.length > 0) {
  const fzAll = order.filter((t) => frozenBy(t));
  say(`❄️  冻结面 ${activeFreeze.map((f) => f.id).join(' ')} 当前冻住 ${fzAll.length} 张未勾票：${fzAll.join(' ') || '—'}（下面的轮数按全量算、不扣冻结；此刻能开的看 \`missed\`）`);
}
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
