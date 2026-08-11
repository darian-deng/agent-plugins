#!/usr/bin/env node
// grill-flow stage-3 完成门（秒级结构检查，fail-closed）。
// 引擎在 AI 写 signal=done 时以 cwd=flowDir 跑 `node scripts/gate-stage-3.cjs`。
// stage-3 无人工 gate——通过即自动进 stage-4，所以这道门尤其必须 fail-closed。
// 断言：① ≥1 已勾 ticket 且无未勾（只认标准复选框）；
//       ② 每个 [x] ticket 自己的块里写了 qc:done（不是全文数 qc:done——说明性文字会灌水）；
//       ③ 每个 [x] ticket 在 base_sha_code..HEAD 有**属于自己的一笔非 merge commit**
//          （subject 含该 ticket 号，且一笔 commit 只能认领一个 ticket；
//           防"勾了 [x] 却没做 / 没 commit"、防一笔 commit 顶多票）。
// 诚实定位：拦"忘做 / 漏 commit / 漏 qc"+ 编译级破坏；拦不住"有 commit 但空实现 / 谎标"——
//          那靠 stage-4 全量测试 + 人工 gate。
//          也分辨不出 squash 回合：`git merge --squash` 产出的是单亲 commit，与手写 commit
//          在拓扑上无从区分，故照单当证据（它确实带着那批代码）。代价只在收紧方向：
//          一笔 squash commit 折进多票时只能认领一票（报争用）、squash 时 subject 丢了票号
//          则报缺 commit —— 两者都 fail-closed，不会因此误放行。
'use strict';

const { existsSync, readFileSync } = require('fs');
const { join } = require('path');
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
const done = [];   // [{ num: 'T1', line: 12, cand: [0, 3] }, ...]，按文件顺序
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
  else done.push({ num: m[2], line: i, cand: [] });
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
// **缩进行**（per-ticket-review 步骤 9：marker 写在该条的行上或其子标记里）。
// 顶格的非 ticket 行（散文说明、`- 说明：…` 列表）不算进任何 ticket 的块。
const missingQc = [];
for (let k = 0; k < done.length; k++) {
  const start = done[k].line;
  const end = k + 1 < done.length ? done[k + 1].line : lines.length;
  let found = /qc:done/.test(lines[start]);
  for (let i = start + 1; i < end && !found; i++) {
    if (/^#{1,6}\s/.test(lines[i])) break;   // 标题 = 块结束
    if (!/^\s+\S/.test(lines[i])) continue;  // 只认缩进子行
    if (/qc:done/.test(lines[i])) found = true;
  }
  if (!found) missingQc.push(done[k].num);
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
// 协议已同步收紧到 subject（per-ticket-review 步骤 7 / stage-3 第 5 步），本门与之一致：
// 宁可让漏写 subject 的 commit 被拦下（AI 可 `git commit --amend` 秒修），
// 也不放行"根本没这笔 commit"——stage-3 无人工 gate，这道门是唯一兜底。
// `--no-merges`：merge commit 不算证据。分支名带票号时（`wt/T2`），git 自动生成的
//   「Merge wt/T2 into feat/req」照样命中 \bT2\b（`/` 非单词字符），于是没写过任何实施
//   commit 的票也能顶过 ③——而 ③ 防的正是这个。按拓扑（父数 ≥ 2）筛而非匹配 "Merge " 字样：
//   后者随 locale 与 `-m` 文案变（`-m "回合 T2"` 不含该词）。侧分支自己那笔仍在区间内、
//   不丢证据；被排除的只有"代码仅存于解冲突 merge"，它本就违反每票一笔独立 commit。
let raw;
try {
  raw = execFileSync('git', ['log', '--format=%s', '--no-merges', baseSha + '..HEAD'], {
    cwd: projectRoot,
    encoding: 'utf-8',
    maxBuffer: 4 * 1024 * 1024,
  });
} catch (e) {
  err('git log ' + baseSha + '..HEAD 失败（base_sha_code 无效或非 git 仓库）: ' + (e.message || e));
  process.exit(FAIL);
}
const subjects = raw.split('\n').filter((l) => l.length > 0);

// 候选：subject 含 \bT<n>\b 的非 merge commit（词边界保证 T1 不误匹配 T10、T10 不误匹配 T1）。
for (const d of done) {
  const re = new RegExp('\\b' + d.num + '\\b');
  for (let ci = 0; ci < subjects.length; ci++) if (re.test(subjects[ci])) d.cand.push(ci);
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
const contested = [];  // 有候选，但候选都被别的 ticket 占了
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

process.exit(PASS);
