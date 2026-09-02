#!/usr/bin/env node
// grill-flow stage-3 完成门（秒级结构检查，fail-closed）。
// 引擎在 AI 写 signal=done 时以 cwd=flowDir 跑 `node scripts/gate-stage-3.cjs`。
// stage-3 无人工 gate——通过即自动进 stage-4，所以这道门尤其必须 fail-closed。
// 断言：① ≥1 已勾 ticket 且无未勾（只认标准复选框）；
//       ② 每个 [x] ticket 自己的块里写了 qc:done（不是全文数 qc:done——说明性文字会灌水）；
//          同趟顺便看 cm:done（注释清理），缺它**只警告不阻断**——见该处注释；
//       ③ 每个 [x] ticket 在 base_sha_code..HEAD 有**属于自己的一笔非 merge commit**
//          （subject 含该 ticket 号，且一笔 commit 只能认领一个 ticket；
//           防"勾了 [x] 却没做 / 没 commit"、防一笔 commit 顶多票）；
//       ④ base_sha_code..HEAD **无 merge commit**（历史线性）；
//       ⑤ 本 flow 落点下无残留 worktree（并行票已全部收口；新旧两个落点都查）；
//       ⑥ 每个 [x] ticket 那笔 commit 实际改的文件 ⊆ 它声明的 Touches；
//       ⑦ 同一 batch 内任两票的实际改动文件集不相交。
//
// ④ 为什么是这道门里最 load-bearing 的一条：③ 与 /clear 重入判据都用 `--no-merges`，
//   所以它们对 merge commit 的内容**完全盲**。实测两个后果，都静默通过：
//   (a) `git merge -X ours <票分支>` 在无文本冲突时输出 `Auto-merging`（不是 CONFLICT）、
//       静默丢弃一侧改动，而该票那笔 commit 仍在区间里 → ③ 绿、代码不在树里；
//   (b) 在 merge 之后 `git commit --amend` 改的是 merge commit（不是该票那笔），
//       适配代码只存在于 merge commit 里 → ③ 绿、且把 merge subject 改成
//       `chore(T1 T2): merged` 门照样绿。
//   `merge-base --is-ancestor` 挡不住它们（ancestry 是拓扑属性，-X ours 丢内容后仍成立）。
//   而"历史线性"能：任何非 ff 合并都必然产生 merge commit，所以线性 = 物理上不可能
//   用 -X ours、也不可能把代码藏进 merge commit，顺带让 ③ 的 `--no-merges` 盲区消失。
//   代价：flow 期间同步主干只能用 rebase 不能用 merge —— 收紧方向，且 stage-4 反正 squash。
// 诚实定位：拦"忘做 / 漏 commit / 漏 qc"+ 编译级破坏；拦不住"有 commit 但空实现 / 谎标"——
//          那靠 stage-4 全量测试 + 人工 gate。
//          也分辨不出 squash 回合：`git merge --squash` 产出的是单亲 commit，与手写 commit
//          在拓扑上无从区分，故照单当证据（它确实带着那批代码）。代价只在收紧方向：
//          一笔 squash commit 折进多票时只能认领一票（报争用）、squash 时 subject 丢了票号
//          则报缺 commit —— 两者都 fail-closed，不会因此误放行。
'use strict';

const { existsSync, readFileSync } = require('fs');
const { join, relative, sep, dirname, basename } = require('path');
const { execFileSync } = require('child_process');

const PASS = 0;
const FAIL = 1;
const err = (m) => process.stderr.write('❌  ' + m + '\n');

const flowDir = join(__dirname, '..');
const projectRoot = join(flowDir, '..', '..');

let state;
try {
  state = require(join(flowDir, 'state', 'active.json'));
} catch (e) {
  err('无法读取 state/active.json: ' + e.message);
  process.exit(FAIL);
}

const flowId = state.flow_id;
if (!flowId) {
  err('active.json 缺 flow_id 字段');
  process.exit(FAIL);
}

// base_sha_code 由 stage-3 入场 Step 1 的 mark-base 触发引擎捕获、写入 active.json。
// 缺它无法核对 ticket↔commit —— fail-closed。
const baseSha = state.base_sha_code;
if (!baseSha) {
  err('active.json 缺 base_sha_code（stage-3 入场 Step 1 未触发 mark-base 捕获？无法核对 ticket↔commit）');
  process.exit(FAIL);
}

const tickets = join(projectRoot, 'docs', 'grill-flows', flowId, 'tickets.md');
if (!existsSync(tickets)) {
  err('缺 tickets.md');
  process.exit(FAIL);
}

const text = readFileSync(tickets, 'utf-8');
const lines = text.split('\n');

// ── 解析 ticket 级行 ──
// ticket 级行 = 顶格 `- [<mark>] T<n>`；缩进的 AC 子项不是 ticket 级行，不参与判定
//（design §13 架构必修 7）。
// `## 待真机验证` 段登记的是"哪些票要真机验"，条目须写成 `- T<n> — …`（非复选框）。
// 该段里出现复选框写法一律**报错**、不静默跳过：跳过会让一条真正未勾的 `- [ ] T7`
// 被吞掉而误放行，而这道门是 stage-3 唯一的引擎兜底，fail-open 比误报危险得多。
// 报错文案直指真实原因（段内格式错），不再让 AI 看到"存在未勾 ticket"这种对不上的提示。
// 段边界认**任意层级**标题（`#`…`######`）——只认 `#`/`##` 会让 `### 子标题` 之后的行
// 继续被当作段内，那正是上面要避免的 fail-open。
// LOOSE 先宽松认出"看起来像 ticket 级行"的行，再要求它严格合规——
// fail-closed：`- [] T1`、`- [-] T1`、`- [x]  T1` 这类既不计 done 也不计 undone 的写法
// 会被静默忽略而误放行，必须显式拦下。
const LOOSE_TICKET_LINE = /^-\s*\[[^\]]*\]\s*T\d/;
const STRICT_TICKET_LINE = /^- \[([ xX])\] (T\d+)/;
// [{ num:'T1', line:12, cand:[0,3], touches:null|[glob], batch:null|'B1' }, ...]，按文件顺序
const done = [];
let undone = 0;
let inRealMachine = false;   // 光标是否落在 `## 待真机验证` 段内
const seen = new Map();      // ticket 号 -> 首次出现行号，用于查重
for (let i = 0; i < lines.length; i++) {
  if (/^#{1,6}\s/.test(lines[i])) inRealMachine = /^##\s/.test(lines[i]) && /待真机验证/.test(lines[i]);
  if (!LOOSE_TICKET_LINE.test(lines[i])) continue;
  if (inRealMachine) {
    err('`## 待真机验证` 段里出现了复选框写法（第 ' + (i + 1) + ' 行）: ' + lines[i].trim()
      + '\n    该段条目必须写成 `- T<n> — <一句话验什么>`（非复选框）——它登记的是"哪些票要真机验"，'
      + '不是 ticket 级完成项。写成复选框会与 ticket 判定混淆。');
    process.exit(FAIL);
  }
  const m = STRICT_TICKET_LINE.exec(lines[i]);
  if (!m) {
    err('tickets.md 存在非标准复选框的 ticket 级行（只认 "- [ ] T<n>" / "- [x] T<n>"）: ' + lines[i].trim());
    process.exit(FAIL);
  }
  // 同一票号出现两次（索引段 + 详情段、或残留副本）会让下面的一一配对要求两笔 commit，
  // 报出"争用"——一个作者根本没有的问题，照它给的修法也修不好。显式拦下并说清真实原因。
  const dup = seen.get(m[2]);
  if (dup !== undefined) {
    err('tickets.md 有重复的 ticket 级行 ' + m[2] + '（第 ' + (dup + 1) + ' 行与第 ' + (i + 1) + ' 行）'
      + '\n    每个 ticket 只能有一条 ticket 级 `- [ ] T<n>` / `- [x] T<n>` 行。'
      + '删掉多余那条（索引/摘要请用不带复选框的写法），否则完成判定与 ticket↔commit 配对都会错。');
    process.exit(FAIL);
  }
  seen.set(m[2], i);
  if (m[1] === ' ') undone++;
  else done.push({ num: m[2], line: i, cand: [], touches: null, batch: null });
}

if (undone > 0) {
  err('还有 ' + undone + ' 个未完成 ticket（未勾 - [ ] T<n>）');
  process.exit(FAIL);
}
if (done.length === 0) {
  // 空文件 / 无 ticket 级项都落这里——显式断言，不放行。
  err('tickets.md 无任何已完成 ticket 级项（空文件或格式不符）');
  process.exit(FAIL);
}

// ── ② 每个已勾 ticket 自己的块里要有 qc:done ──
// 不用全文 `text.match(/qc:done/g)` 计数：tickets.md 是 AI 写的，
// 「每票完成后加 qc:done」这类图例/说明文字会把计数灌水，让门被样板文字满足。
// 块 = 该 ticket 级行本身 + 其后到「下一个 ticket 级行 / 下一个 markdown 标题」之间的
// **缩进行**（stage-3 第 6 步的逐票记账：marker 写在该条的行上或其子标记里）。
// 顶格的非 ticket 行（散文说明、`- 说明：…` 列表）不算进任何 ticket 的块。
// 同一趟顺便收集该票的 `Touches:` 与 `batch:`（块边界定义与 qc:done 完全一致，
// 单独再走一遍只会让两处边界逻辑漂移）。两者都可缺省：
//   - Touches 缺 → ⑥ 跳过该票（本次改动之前创建的 tickets.md 没有这一行，向后兼容）
//   - batch 缺 → 该票是串行执行的，不参与 ⑦
// 同一趟还顺便看 `cm:done`（注释清理已做）。它**只警告、不 fail**，理由是向后兼容：
// 注释清理是后来才从质量链子代理上收给主 session 的，在那之前收口的票面上没有这个字段，
// 硬断言会把一个跑到一半的 flow 整个卡住。缺它的真实防线在 `reentry.md` 的相位表
// （重入时判得出「已 commit 但注释没清」），这里只负责让漏做**可见**。
const missingQc = [];
const missingCm = [];
for (let k = 0; k < done.length; k++) {
  const start = done[k].line;
  const end = k + 1 < done.length ? done[k + 1].line : lines.length;
  let found = /qc:done/.test(lines[start]);
  let foundCm = /cm:done/.test(lines[start]);
  const blockLines = [lines[start]];
  for (let i = start + 1; i < end; i++) {
    if (/^#{1,6}\s/.test(lines[i])) break;   // 标题 = 块结束
    if (!/^\s+\S/.test(lines[i])) continue;  // 只认缩进子行
    blockLines.push(lines[i]);
    if (/qc:done/.test(lines[i])) found = true;
    if (/cm:done/.test(lines[i])) foundCm = true;
  }
  for (const bl of blockLines) {
    const mt = /(?:^|\s)Touches:\s*(.+)$/.exec(bl);
    if (mt && done[k].touches === null) {
      done[k].touches = mt[1].split(/[,\s]+/).map((s) => s.trim()).filter((s) => s.length > 0);
    }
    const mb = /(?:^|\s)batch:\s*(\S+)/.exec(bl);
    if (mb && done[k].batch === null) done[k].batch = mb[1];
  }
  if (!found) missingQc.push(done[k].num);
  if (!foundCm) missingCm.push(done[k].num);
}
// 只在「这个 flow 已经在用 cm:done、但漏了几张」时才说话。全部已勾票都没有它 = 这一轮跑在
// 注释清理上收之前的契约上，那时票面本来就没有这个字段 —— 对那种 flow 报一长串票号是纯噪音。
if (missingCm.length > 0 && missingCm.length < done.length) {
  process.stderr.write('⚠  这些已勾 ticket 没写 cm:done（注释清理由主 session 在 commit 之后、close 之前另派）: '
    + missingCm.join(', ')
    + '\n   不阻断放行。但注释清理一旦漏过 close 就无法 --amend 折回本票那笔了，'
    + '只能另起一笔或留到 stage-4 组装审一并处理。\n');
}
if (missingQc.length > 0) {
  err('这些已勾 ticket 没在自己那条里写 qc:done（写在该 ticket 行上或其缩进子项里，全文别处的 qc:done 不算）: '
    + missingQc.join(', '));
  process.exit(FAIL);
}

// ── ③ 每个已勾 ticket 要有属于自己的一笔 commit ──
// 只读 subject（`%s` 首行），不读 body。理由：per-ticket-review「pre-commit hook 冲突」
// 协议要求把跳过原因写进 message，字面例子就是「consumer 修复落在 T<n>」——这是系统性地
// 往 message 里种前向引用；若整段 message 都算数，T5 的一句提及就能替尚未存在的 T7 顶包。
// 协议已同步收紧到 subject（quality-chain.md 第 5 步 / stage-3 第 5 步），本门与之一致：
// 宁可让漏写 subject 的 commit 被拦下（AI 可 `git commit --amend` 秒修），
// 也不放行"根本没这笔 commit"——stage-3 无人工 gate，这道门是唯一兜底。
// `--no-merges`：merge commit 不算证据。分支名带票号时（`wt/T2`），git 自动生成的
//   「Merge wt/T2 into feat/req」照样命中 \bT2\b（`/` 非单词字符），于是没写过任何实施
//   commit 的票也能顶过 ③——而 ③ 防的正是这个。按拓扑（父数 ≥ 2）筛而非匹配 "Merge " 字样：
//   后者随 locale 与 `-m` 文案变（`-m "回合 T2"` 不含该词）。侧分支自己那笔仍在区间内、
//   不丢证据；被排除的只有"代码仅存于解冲突 merge"，它本就违反每票一笔独立 commit。
function git(args) {
  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf-8',
    maxBuffer: 4 * 1024 * 1024,
  });
}

// 带上 %H：⑥ 要按票反查那笔 commit 实际改了哪些文件，而 Kuhn 匹配的结果是下标，
// 所以 sha 与 subject 必须同序取出、下标对齐。
let raw;
try {
  raw = git(['log', '--format=%H%x09%s', '--no-merges', baseSha + '..HEAD']);
} catch (e) {
  err('git log ' + baseSha + '..HEAD 失败（base_sha_code 无效或非 git 仓库）: ' + (e.message || e));
  process.exit(FAIL);
}
const rows = raw.split('\n').filter((l) => l.length > 0).map((l) => {
  const t = l.indexOf('\t');
  return { sha: l.slice(0, t), subject: l.slice(t + 1) };
});
const subjects = rows.map((r) => r.subject);

// 候选：subject 含 \bT<n>\b 的非 merge commit（词边界保证 T1 不误匹配 T10、T10 不误匹配 T1）。
for (const d of done) {
  const re = new RegExp('\\b' + d.num + '\\b');
  for (let ci = 0; ci < subjects.length; ci++) if (re.test(subjects[ci])) d.cand.push(ci);
}

// 一笔 subject 里出现多个票号，会让下面的最大匹配**不唯一**——而不唯一的匹配可以是
// 「合法但对调」的：两票各只改了自己声明的文件，配对却互换，于是断言⑥ 把两票都报成越界，
// 报错还建议把对方的文件补进自己的 Touches（照做之后⑦ 接着报相交，死循环）。而且换个提交
// 顺序同样的状态就通过了，门因此是不确定的。
// 契约本来就要求「subject 首行只含本票号」，这里给它一条机器检查，让配对必然唯一。
const multi = [];
for (const r of rows) {
  const hits = done.map((d) => d.num).filter((n) => new RegExp('\\b' + n + '\\b').test(r.subject));
  if (hits.length > 1) multi.push({ ...r, hits });
}
if (multi.length > 0) {
  err('这些 commit 的 subject 里出现了多个票号（一笔只能认领一票）:\n'
    + multi.map((m) => '      ' + m.sha.slice(0, 8) + ' ' + m.subject + '   ← 命中 ' + m.hits.join(' ')).join('\n')
    + '\n    为什么卡这个：ticket↔commit 是一一配对的，一笔命中多票会让配对有多个合法解，'
    + '于是断言⑥⑦ 可能按「对调」的那一解去核写集——两票都被报成越界、且提示方向是反的，'
    + '照着改会陷入死循环。同样的状态换个提交顺序又会通过，门变得不确定。'
    + '\n    怎么改：改写这些 subject，每笔只留它自己那一个票号；要提及别的票就写进 body'
    + '（门只读 subject 首行）。**交互式 rebase 在本环境起不来（无 tty）**，用非交互形态：\n'
    + '      GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash --autostash <base_sha_code>\n'
    + '    只改 subject 时用 `git rebase --exec "git commit --amend -m ..."` 或逐笔 `--amend`；'
    + '`--autostash` 不能省——stage-3 期间主树一直有未提交的记账改动，rebase 会因此直接拒绝。');
  process.exit(FAIL);
}

// 一一配对（二分图最大匹配，Kuhn 增广路）：一笔 commit 只能认领一个 ticket。
// 否则一笔 message 写成「T1 T2 T3」的 commit 能同时满足三票。
// 规模 = 已勾票数 × 区间 commit 数（几十级），秒级完成。
const owner = new Array(subjects.length).fill(-1); // commit 下标 -> ticket 下标
function assign(ti, seen) {
  for (const ci of done[ti].cand) {
    if (seen[ci]) continue;
    seen[ci] = true;
    if (owner[ci] === -1 || assign(owner[ci], seen)) { owner[ci] = ti; return true; }
  }
  return false;
}
const noCommit = [];   // 压根没有 subject 含自己票号的 commit
// 有候选、但候选都被别的 ticket 占了。上面「一笔 subject 不得含多个票号」通过之后，
// 每笔 commit 最多匹配一个票号（词边界保证 T1 不匹配 T10），票号重复也已拦下，
// 于是各票的候选集互不相交、最大匹配必然成立——这一支理论上不可达。留作 fail-closed
// 兜底：真被触发说明上面某条前置断言有漏洞，那时报出来比静默放行好。
const contested = [];
for (let ti = 0; ti < done.length; ti++) {
  if (assign(ti, new Array(subjects.length).fill(false))) continue;
  (done[ti].cand.length === 0 ? noCommit : contested).push(done[ti].num);
}

if (noCommit.length > 0 || contested.length > 0) {
  const short = baseSha.slice(0, 8);
  if (noCommit.length > 0) {
    err('这些已勾 ticket 在 ' + short + '..HEAD 没有自己的 commit'
      + '（要求某笔「非 merge」commit 的 subject 首行含票号；body 里的提及不算'
      + '——「consumer 修复落在 T<n>」这类前向引用不能当证据；merge commit 也不算'
      + '——分支名带票号时「Merge wt/T<n> into …」这种自动 subject 不是实施证据）: ' + noCommit.join(', ')
      + '\n    怎么改：确实做了 → 补提交或 `git commit --amend` 把票号写进 subject 首行'
      + '（若该票的改动只落在一笔解冲突 merge commit 里，就补一笔带票号的普通 commit）；'
      + '确实没做 → 把该 ticket 改回 `- [ ] T<n>` 并继续实施，别勾 [x]。');
  }
  if (contested.length > 0) {
    err('这些已勾 ticket 只能与别的 ticket 争用同一笔 commit——一笔 commit 只能认领一个 ticket: '
      + contested.join(', ')
      + '\n    三种可能：(a) 一笔 commit 的 subject 写了多个票号、顶了多票；'
      + '(b) 该票压根没自己的 commit，只是被别人 subject 里的提及（如「修复落在 T<n>」）蹭到了；'
      + '(c) 回合方式用了 `git merge --squash`——多票的改动被折进一笔 commit，'
      + '或该票原本那笔 commit 的 subject 在 squash 时丢了票号，只剩别人的票号在里面。'
      + '\n    怎么改：先分清是哪一种。(c) 别去拆已有 commit——换成保留每票各自 commit 的回合方式'
      + '（merge / rebase / cherry-pick 都保留原 commit），或给该票补一笔自己的 commit；'
      + '(a) 把顶多票的 commit 拆开；(b) 为缺的票补自己的 commit'
      + '（subject 首行含它自己的票号；subject 里顺带提到别的票号本身不算问题，'
      + '一笔 commit 不能同时被两票认领才是）；确实没做的票改回 `- [ ] T<n>`。');
  }
  process.exit(FAIL);
}

// 配对成立之后才查"有没有多余的 commit"：上面那两条（该票压根没有 commit / 争用）是更
// 根本的诊断，先报它们，避免作者看到一条不相干的"某笔 commit 不归属任何票"。
//
// 匹配只要求每票**至少**一笔，于是多出来的 commit（一票两笔、或压根没写票号的顺手提交）
// 会留在 owner[ci] === -1，而 ⑥⑦ 是按"该票那笔 commit 改了哪些文件"判的，看不见它们——
// 越界改动只要落在没被匹配到的那一笔里就能整个逃过 ⑥，同 batch 的相交写落在那里就能逃过 ⑦。
// 更糟的是这让门变得不确定：同样两笔，越界那笔是最新的就抓到、是较老的就放行。
// 每票一笔独立 commit 本来就是本 stage 的契约，所以直接要求区间内每笔都归属某一票。
const orphans = [];
for (let ci = 0; ci < rows.length; ci++) if (owner[ci] === -1) orphans.push(rows[ci]);
if (orphans.length > 0) {
  err('区间 ' + baseSha.slice(0, 8) + '..HEAD 有 ' + orphans.length + ' 笔 commit 不归属任何 ticket:\n'
    + orphans.map((r) => '      ' + r.sha.slice(0, 8) + ' ' + r.subject).join('\n')
    + '\n    为什么卡这个：断言⑥⑦ 按"该票那笔 commit 改了哪些文件"核写集，不归属任何票的 commit'
    + '它们完全看不见——越界改动或同批相交写只要落在这种 commit 里就能整个逃过去。'
    + '\n    怎么改：本 stage 的契约是每票一笔独立代码 commit。属于某票 → 两条命令 squash 进该票那笔：\n'
    + '      git commit --fixup=<该票那笔的 sha>   # 若那笔还没提交则先这样提\n'
    + '      GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash --autostash <base_sha_code>\n'
    + '    两个都不能省：本环境没有 tty，交互式 rebase 起不来，`GIT_SEQUENCE_EDITOR=true` 让它'
    + '直接接受自动生成的 todo；`--autostash` 保住主树那些未提交的记账改动（否则 rebase 直接拒绝，'
    + '而按它的提示去提交记账又会造出一笔不归属任何票的 commit、被本条再次拦下）。\n'
    + '    是顺手提交的无关改动 → 它不该在本 flow 的区间里，摘出去或补一张 ticket 认领它。');
  process.exit(FAIL);
}

// ── ④ 历史线性：区间内不得有 merge commit ──
// 理由见文件头。这条同时是 ⑥ 可信的前提：⑥ 靠"该票那笔 commit 改了哪些文件"判断，
// 而 merge commit 里的改动不属于任何一笔票 commit，⑥ 会看不见它。
let mergeRaw;
try {
  mergeRaw = git(['log', '--format=%h %s', '--merges', baseSha + '..HEAD']);
} catch (e) {
  err('git log --merges 失败: ' + (e.message || e));
  process.exit(FAIL);
}
const merges = mergeRaw.split('\n').filter((l) => l.length > 0);
if (merges.length > 0) {
  err('区间 ' + baseSha.slice(0, 8) + '..HEAD 有 ' + merges.length + ' 笔 merge commit，本 stage 要求历史线性:\n'
    + merges.map((m) => '      ' + m).join('\n')
    + '\n    为什么卡这个：③ 与 /clear 重入判据都用 `--no-merges`，对 merge commit 的内容完全盲。'
    + '于是「`-X ours` 静默丢掉一侧改动」和「适配代码被 amend 进 merge commit」这两种情况'
    + '都能让本门全绿而代码不在树里/不归属任何票。历史线性从物理上排除这两种。'
    + '\n    怎么改：回合票分支用 `git merge --ff-only <branch>`（子代理应先在自己 worktree 里'
    + '`git rebase <主分支>` 完成适配，回合才会是 ff）；flow 期间要同步主干同样用 rebase 不用 merge。'
    + '已经产生的 merge：`git rebase` 摊平，或 `git reset --soft ' + baseSha.slice(0, 8)
    + '` 后按票重新提交。');
  process.exit(FAIL);
}

// ── ⑤ worktree 已收口 ──
// 只看本 flow 落点下的那些。不能写成"除主工作树外为空"：
// 开发者常年挂着与本 flow 无关的 worktree，那样会让这道门恒失败。
// 必须先 prune：手动 `rm -rf` 掉目录后条目仍会以 prunable 状态留在 list 里。
try {
  git(['worktree', 'prune']);
} catch { /* prune 失败不致命，下面的 list 仍会如实报告 */ }
let wtRaw;
try {
  wtRaw = git(['worktree', 'list', '--porcelain']);
} catch (e) {
  err('git worktree list 失败: ' + (e.message || e));
  process.exit(FAIL);
}
// 收窄到本 flow 自己那些（名字 `<flow_id>-T<n>` / `<flow_id>-R<n>`，`worktree.cjs open`
// 的命名）：开发者可能常年挂着与本 flow 无关的工作目录，那种不该让这道门恒失败。
// abort 那侧用的是同一判据。
// **两个落点都要查**：0.50.0 起 worktree 开在仓库同级的 `<repo 名>.ai-flow-worktrees/`
// （嵌在仓库内时模块解析会越界到主检出的 `node_modules`，同一个包两个物理路径、
// worktree 里 typecheck 必然报错），而升级前开出去的树还在 `<锚点>/.worktrees/` 下。只查一个
// 就会漏掉另一个，而漏掉的方向是 fail-open——残留的工作树带着未合回来的改动，门却放行。
const wtPrefixes = [join(projectRoot, '.worktrees') + '/' + flowId + '-'];
try {
  const top = git(['rev-parse', '--show-toplevel']).trim();
  wtPrefixes.push(join(dirname(top), basename(top) + '.ai-flow-worktrees') + '/' + flowId + '-');
} catch { /* 非 git 仓库时上面的 git log 早已 fail-closed，走不到这里 */ }
const staleWt = wtRaw.split('\n')
  .filter((l) => l.startsWith('worktree '))
  .map((l) => l.slice('worktree '.length).trim())
  .filter((p) => wtPrefixes.some((pre) => p.startsWith(pre)));
if (staleWt.length > 0) {
  err('还有 ' + staleWt.length + ' 个未收口的 worktree（并行票没合回来 / 没拆掉）:\n'
    + staleWt.map((p) => '      ' + p).join('\n')
    + '\n    怎么改：逐个确认该票已 `git merge --ff-only` 回合，然后 `git worktree remove <path>`。'
    + '拆之前先在该 worktree 里跑 `git status --porcelain` 确认为空——里面若有未追踪文件'
    + '（fixture / migration / 运行时读的 JSON），它们不在任何 commit 里，'
    + '`--force` 拆掉就永久丢失，而本门与 stage-4 的 `git add -A` 都看不到另一棵工作树。');
  process.exit(FAIL);
}

// ── ⑥ 每票实际改动 ⊆ 它声明的 Touches ──
// Touches 是 stage-2 切片时声明的预计写集，也是"这两票可以并行"的唯一依据。
// 让子代理自己回报"我超出声明了吗"是让被测方自证；这里直接按 git 事实核。
// 声明缺失（老 tickets.md）→ 跳过该票，不阻断。
function globToRe(g) {
  // 目录前缀（以 / 结尾）= 其下所有文件
  const pat = g.endsWith('/') ? g + '**' : g;
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') {
      if (pat[i + 1] === '*') { re += '.*'; i++; if (pat[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
// ⑥⑦ 的路径基准：`git show --name-only` 输出的是 **git 根相对**路径，而 `Touches` 是
// 开发者照**锚点**（projectRoot）写的。monorepo 子项目锚点下两者不同——本插件自己就是
// 这种结构（锚点 plugins/ai-flow、git 根是仓库根），`git show` 会输出
// `plugins/ai-flow/src/…`，于是 `Touches: src/…` 永远匹配不上、⑥ 全票误报，
// `docs/grill-flows/` 前缀判定也失效、⑦ 里任意两票都会在 tickets.md 上"相交"。
// 统一到锚点相对：把 git 根相对路径剥掉这段前缀；落在锚点之外的改动保持 git 根相对
// （它们本来就不该出现在票的 Touches 里，让 ⑥ 如实报越界）。
let anchorPrefix = '';
try {
  const top = git(['rev-parse', '--show-toplevel']).trim();
  const rel = relative(top, projectRoot).split(sep).join('/');
  if (rel && rel !== '..' && !rel.startsWith('../')) anchorPrefix = rel + '/';
} catch { /* 非 git 仓库时上面的 git log 早已 fail-closed，走不到这里 */ }
const toAnchorRel = (f) => (anchorPrefix && f.startsWith(anchorPrefix) ? f.slice(anchorPrefix.length) : f);

// flow 自己的记账区不参与 ⑥⑦：`docs/grill-flows/**` 是每票都会碰的进度/候选账本
// （tickets.md 的 qc:done、candidates.md），`.ai-flow/<flow>/state/` 是控制面运行时。
// 把它们算进"实际改动"会让 ⑥ 报出一个看不懂的越界、并让 ⑦ 里任意两票都"写集相交"。
// 同一条排除在 assembly-review 环节 B 已有先例（`:(exclude)docs/grill-flows/*`）。
// 只豁免这两处：`.ai-flow/` 整目录豁免会白送一个盲区（stage 提示词 / gate 脚本 / config
// 都在那儿，票本来就不该碰——控制面保护也会拦），所以收窄到 state/。
const isBookkeeping = (f) =>
  f.startsWith('docs/grill-flows/') || /^\.ai-flow\/[^/]+\/state\//.test(f);

const ownerOf = new Map();  // ticket 号 -> 该票那笔 commit 的 sha
for (let ci = 0; ci < owner.length; ci++) if (owner[ci] !== -1) ownerOf.set(done[owner[ci]].num, rows[ci].sha);
const filesOf = new Map(); // ticket 号 -> string[]（已剔除记账区）
const touchViolations = [];
for (const d of done) {
  const sha = ownerOf.get(d.num);
  if (!sha) continue;
  let files;
  try {
    // `core.quotePath=false`：默认会把非 ASCII 路径转义成 "src/\346\226\207…"，那种形态
    //   与任何 Touches glob 都匹配不上——含中日文文件名的项目会被 ⑥ 一进来就卡死。
    // `--no-renames`：默认开重命名检测、只报新路径。一票把别票的文件 `git mv` 走时，
    //   旧路径的删除对 ⑥⑦ 不可见（写集相交被隐藏）。关掉后旧新两条都报。
    files = git(['-c', 'core.quotePath=false', 'show', '--name-only', '--no-renames', '--format=', sha])
      .split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
      .map(toAnchorRel).filter((s) => !isBookkeeping(s));
  } catch (e) {
    err('git show ' + sha.slice(0, 8) + ' 失败: ' + (e.message || e));
    process.exit(FAIL);
  }
  filesOf.set(d.num, files);
  // 剔除记账区之后一个文件都没有 = 这票没有代码交付。空提交能过 ③（有 commit）、
  // 也能过 ⑥⑦（空集不越界、与谁都不相交），只能在这里显式拦。
  if (files.length === 0) {
    err(d.num + ' 那笔 commit（' + sha.slice(0, 8) + '）剔除记账区后没有改动任何文件——这票没有代码交付。'
      + '\n    怎么改：改动落在别处（主树？另一票的分支？）→ 归位后 amend 进本票那笔；'
      + '这票确实无需代码改动 → 它不该是一张 ticket，从 tickets.md 撤掉。');
    process.exit(FAIL);
  }
  if (d.touches === null) {
    // 不静默：门看着在把关、实际对这票是空操作，是比不设门更危险的状态。
    process.stderr.write('⚠  ' + d.num + ' 没有可解析的 Touches 声明（该票行内或其缩进子项），已跳过断言⑥\n');
    continue;
  }
  // `Touches: none` 按 gate-stage-2 的定义是「预估不了写集，该票只能串行执行」——不是
  // 「不碰任何文件」，所以跳过⑥ 是设计如此，不能按空集核（那会把设计如此的票判成越界）。
  // 但跳过必须可见：车道模式下⑦ 整体不生效，⑥ 是唯一的写集防线，而一张 `none` 票在这条
  // 防线上就是个洞。与下面 `touches === null` 那条同一个原则——门看着在把关、实际对这票
  // 是空操作，是比不设门更危险的状态。
  if (d.touches.some((t) => /^(none|无|-|—)$/i.test(t))) {   // 全角破折号：与 schedule.cjs 的判据对齐，否则 `Touches: —` 会被当成真 glob、该票全部文件判越界
    process.stderr.write('⚠  ' + d.num + ' 的 Touches 是 none（预估不了写集、只能串行），'
      + '断言⑥ 对它是空操作——它改了什么没有任何机器检查\n');
    continue;
  }
  const res = d.touches.map(globToRe);
  const stray = files.filter((f) => !res.some((r) => r.test(f)));
  if (stray.length > 0) touchViolations.push({ num: d.num, stray, declared: d.touches });
}
if (touchViolations.length > 0) {
  for (const v of touchViolations) {
    err(v.num + ' 实际改的文件超出它声明的 Touches:\n'
      + '      声明: ' + v.declared.join(' ') + '\n'
      + '      未声明却改了: ' + v.stray.join(' ')
      + '\n    为什么卡这个：Touches 是"这些票写集不相交、可以并行"的唯一依据，声明不准'
      + '并行安全就是空话。\n    怎么改：改动确实属于本票 → 把这些路径补进该票的 Touches 行；'
      + '改动其实属于另一件事 → 拆成单独的 ticket。');
  }
  process.exit(FAIL);
}

// ── ⑦ 同 batch 内实际写集不相交 ──
// ⑥ 只验"声明 vs 实际"，验不到"这一批彼此之间是否真的不相交"——批次成员关系
// 只存在于 `batch:` 字段里。不用声明的 Touches 而用实际文件：声明可以写得很宽。
const batches = new Map();
for (const d of done) {
  if (!d.batch) continue;                            // 串行票不参与
  if (!batches.has(d.batch)) batches.set(d.batch, []);
  batches.get(d.batch).push(d.num);
}
// 不静默（与⑥ 跳过时同一个原则）：车道模式记的是 `lane:` 不是 `batch:`，于是**全部**票
// 都不参与⑦，而门照样全绿——实测一次 51 票的 flow 里 `batch:` 只出现 1 次，⑦ 从头到尾
// 等于没开。stage-3 的文档承认了这条代价并指定了替代保护（tickets.md 末尾那份「已知会撞
// 的文件」清单交给 stage-4 逐行人查），但门自己不说，读输出的人无从知道保护换成了人工。
// 按「没参与⑦ 的票数」判，不按 batch 数——`batches.size === 0` 漏掉最常见的形态：
// 混合跑法下只要有一张票带了 `batch:`，size 就是 1，而单成员 batch 一对都比不出来，
// ⑦ 对其余 N-1 张仍然等于没开。实测一次 51 票的 flow 里 `batch:` 只出现 1 次。
const noBatch = done.filter((d) => !d.batch).length;
if (noBatch > 0) {
  process.stderr.write('⚠  ' + done.length + ' 张已勾票中有 ' + noBatch + ' 张没有 batch: 标记'
    + '（车道模式记的是 lane:），断言⑦ 对它们不生效——这些票之间「改同一文件的不同区段」'
    + '没有任何机器保护，须按 tickets.md 的「已知碰撞面」清单在 stage-4 组装审逐行人工复核\n');
}
const overlaps = [];
for (const [b, nums] of batches) {
  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) {
      const a = new Set(filesOf.get(nums[i]) || []);
      const shared = (filesOf.get(nums[j]) || []).filter((f) => a.has(f));
      if (shared.length > 0) overlaps.push({ b, a: nums[i], c: nums[j], shared });
    }
  }
}
if (overlaps.length > 0) {
  for (const o of overlaps) {
    err('batch ' + o.b + ' 内 ' + o.a + ' 与 ' + o.c + ' 改了相同文件（并行准入条件是写集不相交）:\n'
      + '      ' + o.shared.join(' ')
      + '\n    怎么改：这两票本就该串行（给后者加 `Blocked by: ' + o.a + '`）或合并成一票；'
      + '⛔ 若已经这样跑完了：**不要为了过门而删掉 `batch:` 标记**——`batch:` 是本条检查唯一的触发条件，'
      + '删掉等于把并行安全的唯一机器依据关掉、门直接变绿。正确做法是给后归并那票补 `Blocked by`、把它移出本批（改成单独一批），'
      + '并在 stage-4 组装审时重点看这几个文件的交界面，'
      + '下轮切片时把耦合切进同一票。');
  }
  process.exit(FAIL);
}

process.exit(PASS);
