#!/usr/bin/env node
// grill-flow stage-2 完成门（秒级结构检查，fail-closed）。
// 引擎在 AI 写 signal=done 时以 cwd=flowDir 跑 `node scripts/gate-stage-2.cjs`。
// exit 0 = 通过（随后进人工 gate）；非 0 = deny 写 signal，stderr 回给 AI 逼修。
// 只做结构检查（文件存在 + 查看器锚点已注入 + 段落非空 + ticket 格式），不跑测试、不做语义判断。
'use strict';

const { existsSync, readFileSync, statSync } = require('fs');
const { execFileSync } = require('child_process');
const { join } = require('path');

const PASS = 0;
const FAIL = 1;
const err = (m) => process.stderr.write('❌  ' + m + '\n');

// __dirname = <proj>/.ai-flow/grill-flow/scripts —— 用它定位，不依赖 cwd。
const flowDir = join(__dirname, '..');
const projectRoot = join(flowDir, '..', '..');

let flowId;
try {
  flowId = require(join(flowDir, 'state', 'active.json')).flow_id;
} catch (e) {
  err('无法读取 state/active.json 的 flow_id: ' + e.message);
  process.exit(FAIL);
}
if (!flowId) {
  err('active.json 缺 flow_id 字段');
  process.exit(FAIL);
}

const docsDir = join(projectRoot, 'docs', 'grill-flows', flowId);
const spec = join(docsDir, 'spec.md');
const tickets = join(docsDir, 'tickets.md');
const html = join(docsDir, 'tech-design.html');

// fail-closed：每个被检文件先确认存在（缺文件直接失败，绝不放行）。
for (const [name, p] of [['spec.md', spec], ['tickets.md', tickets], ['tech-design.html', html]]) {
  if (!existsSync(p)) {
    err('缺文件: docs/grill-flows/' + flowId + '/' + name);
    process.exit(FAIL);
  }
}

// tech-design.html：查看器资产必须已注入（spec-view.md 完成判据）。
// 锚点残留 = 注入步骤漏跑，全屏查看器静默失效——HTML 注释在渲染页不可见，
// 人工 gate 上方案页"看着完整"，只有真去点全屏才发现没反应，所以人审兜不住这条。
const htmlText = readFileSync(html, 'utf-8');
if (htmlText.includes('<!--VIEWER_CSS-->') || htmlText.includes('<!--VIEWER_JS-->')) {
  err('tech-design.html 仍残留 <!--VIEWER_CSS--> / <!--VIEWER_JS--> 占位锚点（查看器资产未注入，全屏查看器会静默失效）'
    + '\n    怎么改：按 references/spec-view.md 的资产注入步骤，把 viewer.css / viewer.js 内容替换进这两个锚点，'
    + '再确认 grep -c \'VIEWER_CSS\\|VIEWER_JS\' 该文件为 0。');
  process.exit(FAIL);
}

// spec.md 三个段必须存在且非空（段标题到下一个 ## / 文件尾之间有非空白内容）。
// 段标题字符串与 stage-2 提示词写死一致（改一处必同步另一处，否则门永远失败）。
function sectionNonEmpty(text, heading) {
  const esc = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 前缀匹配，不锚行尾——允许标题后带注解（如 "## User Stories（编号）"），
  // 避免注解诱导下门永远失败（见 design §13 架构必修1 的字符串对死风险）。
  const re = new RegExp('^##\\s+' + esc, 'm');
  const m = re.exec(text);
  if (!m) return false;
  const rest = text.slice(m.index + m[0].length);
  const nextIdx = rest.search(/^##\s/m);
  const body = (nextIdx === -1 ? rest : rest.slice(0, nextIdx)).trim();
  return body.length > 0;
}
const specText = readFileSync(spec, 'utf-8');
for (const h of ['User Stories', 'Testing Decisions', '方案审查']) {
  if (!sectionNonEmpty(specText, h)) {
    err('spec.md 的 "## ' + h + '" 段缺失或为空');
    process.exit(FAIL);
  }
}

// tickets.md：至少 1 个 ticket 级项（- [ ] T<n> / - [x] T<n>），每个都声明 Blocked by + Touches。
//
// 这两个字段是 stage-3 派发的输入，语义不同、缺一不可：
//   Blocked by = 实施先后（前置票没做完，这票没法做/没法验证）→ frontier 用它算够格
//   Touches    = 预计写集（这票会改哪些文件）→ 并行准入用它算"批内不相交"
// 只校验"Blocked by 这四个字在不在"是不够的：`Blocked by: TBD`、引用不存在的票号、
// 甚至 T3↔T5 互相 blocked（环）都能过门，而 stage-3 要拿它算并行批次。
// 所以这里解析到票号级别，校验引用完整性 + 无自依赖 + 无环。
const lines = readFileSync(tickets, 'utf-8').split('\n');
const idxs = [];
const nums = [];
const seen = new Map();
lines.forEach((l, i) => {
  const m = /^- \[[ xX]\] (T\d+)/.exec(l);
  if (!m) return;
  // 重复票号必须在这里拦，不能留给 stage-3 的门：deps 以票号为 key，后写覆盖先写，
  // 于是「T1 blocked by T2 / T2 blocked by T1 / T1(重复) blocked by none」会让环检测
  // 整个失效。而环在 stage-3 里的表现是 frontier 空转（"卡住"而非报错）。
  const dup = seen.get(m[1]);
  if (dup !== undefined) {
    err('tickets.md 有重复的 ticket 级行 ' + m[1] + '（第 ' + (dup + 1) + ' 行与第 ' + (i + 1) + ' 行）'
      + '\n    怎么改：每个 ticket 只能有一条 ticket 级 `- [ ] T<n>` 行（索引/摘要用不带复选框的写法）。'
      + '重复会让依赖图的后一条覆盖前一条，环检测与 stage-3 的批次计算都会算错。');
    process.exit(FAIL);
  }
  seen.set(m[1], i);
  idxs.push(i); nums.push(m[1]);
});
if (idxs.length === 0) {
  err('tickets.md 无 ticket 级项（应形如 "- [ ] T1 <标题>"）');
  process.exit(FAIL);
}
const known = new Set(nums);
const deps = new Map();   // T<n> -> [T<m>...]
for (let k = 0; k < idxs.length; k++) {
  const start = idxs[k];
  const end = k + 1 < idxs.length ? idxs[k + 1] : lines.length;
  // 块的口径必须与 gate-stage-3 一致：该 ticket 级行本身 + 其后的**缩进**子行。
  // 用「票行到下一票行之间的全部内容」会放过顶格写的 `Touches:`——那种写法能过本门，
  // 却被 stage-3 的 ⑥ 无声跳过（它只认缩进子行），门就变成了空操作。
  const blockLines = [lines[start]];
  for (let i = start + 1; i < end; i++) {
    if (/^#{1,6}\s/.test(lines[i])) break;
    if (!/^\s+\S/.test(lines[i])) continue;
    blockLines.push(lines[i]);
  }
  const block = blockLines.join('\n');
  const self = nums[k];
  const head = lines[start].trim();

  // 行锚：无锚的 /Blocked by:?…/ 会吃到 AC 里出现的「Blocked by」字样（例如
  // "AC: 文档说明 Blocked by 的含义是…"），把散文当成票号列表报错，而真正那行在它后面。
  const mb = /^\s*[-*]?\s*Blocked by:\s*([^\n]*)$/im.exec(block);
  if (!mb) {
    err('ticket 缺 "Blocked by" 声明: ' + head
      + '\n    怎么改：在该 ticket 块里加一行 `Blocked by: T1, T2`；无前置依赖写 `Blocked by: none`。');
    process.exit(FAIL);
  }
  const rawDeps = mb[1].trim();
  let list = [];
  if (!/^(none|无|-|—)$/i.test(rawDeps)) {
    list = rawDeps.split(/[,，\s]+/).map((s) => s.trim()).filter((s) => s.length > 0);
    const bad = list.filter((s) => !/^T\d+$/.test(s));
    if (bad.length > 0) {
      err(self + ' 的 "Blocked by" 不是票号列表: ' + rawDeps
        + '\n    未识别: ' + bad.join(' ')
        + '\n    怎么改：只写票号，逗号或空格分隔（`Blocked by: T1, T3`）；无依赖写 `Blocked by: none`。'
        + 'stage-3 要按它算并行批次，`TBD`/散文都会让批次算错。');
      process.exit(FAIL);
    }
    const unknown = list.filter((s) => !known.has(s));
    if (unknown.length > 0) {
      err(self + ' 的 "Blocked by" 引用了不存在的票号: ' + unknown.join(' ')
        + '\n    现有票号: ' + nums.join(' ')
        + '\n    怎么改：改成真实票号，或删掉该引用。悬空引用会让 frontier 永远算不出这票。');
      process.exit(FAIL);
    }
    if (list.includes(self)) {
      err(self + ' 的 "Blocked by" 引用了自己（自依赖）: ' + rawDeps
        + '\n    怎么改：删掉自引用。自依赖让这票永远不够格、frontier 会卡死。');
      process.exit(FAIL);
    }
  }
  deps.set(self, list);

  // 同样要求缩进 + **非空值**：`Touches:` 后面空着能过存在性检查，而 stage-3 的 ⑥ 要求
  // 有值（`Touches:\s*(.+)$`），拿不到就静默跳过该票——门看着在把关、实际是空操作。
  const mt = /^\s+[-*]?\s*Touches:\s*(\S[^\n]*)$/m.exec(block);
  if (!mt) {
    err('ticket 缺可解析的 "Touches" 声明（要写成该 ticket 行的**缩进**子项、且必须有值）: ' + head
      + '\n    怎么改：在该 ticket 行下面加一行缩进的 `Touches: <预计改的文件/目录>`'
      + '（空格或逗号分隔，支持 glob，如 `src/lib/state.ts src/hooks/ tests/*.test.ts`）。'
      + '它是 stage-3 判定"哪些票写集不相交、可以并行"的唯一依据，也会被 stage-3 机器门'
      + '按实际改动核对。确实无法预估就写 `Touches: none`——该票只能串行执行。'
      + '\n    注意：顶格写（不缩进）能过本门但会被 stage-3 的断言⑥ 静默跳过，所以这里一并拦下。');
    process.exit(FAIL);
  }
  const touches = mt[1].trim();
  if (!/^(none|无|-|—)$/i.test(touches)) {
    const items = touches.split(/[,，\s]+/).filter((s) => s.length > 0);
    // 花括号：stage-3 按 [,\s] 切分 + 转义元字符，`{a,b}` 会被切成 `a{b` / `b}` 后双重失配。
    const brace = items.filter((s) => /[{}]/.test(s));
    if (brace.length > 0) {
      err(self + ' 的 "Touches" 用了花括号展开（不支持）: ' + brace.join(' ')
        + '\n    怎么改：拆成并列的多项（`src/a.ts src/b.ts`），或用 `*` / 目录前缀。');
      process.exit(FAIL);
    }
    // 通配全仓等于把断言⑥ 关掉：`**` 编译成 `^.*$`，该票改什么都不越界，而
    // 「Touches 是并行安全的唯一依据」这句话就变成空的。
    const wildcard = items.filter((s) => /^(\*\*|\*|\.\/?|\*\*\/\*)$/.test(s));
    if (wildcard.length > 0) {
      err(self + ' 的 "Touches" 用了通配全仓的写法: ' + wildcard.join(' ')
        + '\n    怎么改：这等于不声明——stage-3 的断言⑥ 会对该票恒真，并行安全就没有依据了。'
        + '写具体的目录或文件；真的预估不了就写 `Touches: none`（该票只能串行执行）。');
      process.exit(FAIL);
    }
    // `../` 是跨包票的自然写法，但 stage-3 的 ⑥ 比的是**路径字符串**而不是文件系统位置：
    // 它把 git 根相对路径剥掉锚点那一段前缀再比，任何 `..` 都匹配不上。后果是该票**全部**
    // 改动被判越界，而报错说的是"把这些路径补进 Touches"——那里已经写着了，方向完全指反。
    // 排在尾斜杠检查之前：裸 `..` 会先命中那一条，报出"目录漏了尾斜杠"这种对不上的原因。
    const upward = items.filter((s) => s === '..' || s.startsWith('../') || s.includes('/../'));
    if (upward.length > 0) {
      err(self + ' 的 "Touches" 用了 `..` 上溯路径: ' + upward.join(' ')
        + '\n    怎么改：flow 锚点（项目根）之内的路径写成锚点相对（`src/hooks/`），'
        + '锚点之外的包写成**仓库根相对**（`packages/net/src/`、`apps/web4/src/`）——'
        + '后者是 stage-3 断言⑥ 唯一能匹配上的形态。'
        + '\n    为什么卡这个：`..` 匹配不上任何实际改动，该票所有改动都会被判越界，'
        + '而报错方向和真实原因相反，照着改会陷入死循环。');
      process.exit(FAIL);
    }
    // 目录必须带尾斜杠：stage-3 的 glob 只在结尾是 `/` 时展开成"其下所有"，
    // `src/lib`（漏斜杠）会被编译成 `^src/lib$`、匹配零个文件 → 该票所有改动判越界。
    // 判据是「不以 / 结尾、没有通配符、也没有扩展名」——只查「不含 / 」抓不到 `src/lib`
    // 这种真实的漏斜杠写法（它有斜杠），而那正是最常见的一种。
    // 先问磁盘，问不到才用启发式。只看扩展名会把 `.github/CODEOWNERS`、`Makefile`、
    // `LICENSE` 这类**无扩展名的真实文件**判成漏斜杠的目录（实测在本仓真实 tickets.md 上
    // 触发过），而它给的修法是写成 `./CODEOWNERS`——一个为了绕过检查而存在的丑写法。
    // 反过来，存在且确实是目录的（`src/lib`）现在从「猜」变成「确定」，判得更准。
    // `Touches` 的基准可能是 flow 锚点也可能是 git 根（跨包票），两个都试。
    const gitRoot = (() => {
      try {
        return execFileSync('git', ['-C', projectRoot, 'rev-parse', '--show-toplevel'], {
          encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch { return projectRoot; }
    })();
    const onDisk = (rel) => {
      for (const base of [projectRoot, gitRoot]) {
        try { return statSync(join(base, rel)); } catch { /* 换下一个基准 */ }
      }
      return null;
    };
    const looksLikeDir = items.filter((s) => {
      if (s.endsWith('/') || /[*?]/.test(s)) return false;
      const st = onDisk(s);
      if (st) return st.isDirectory();          // 磁盘说了算
      return !/\.[A-Za-z0-9]+$/.test(s);         // 还不存在（本票将新建）→ 退回启发式
    });
    if (looksLikeDir.length > 0) {
      err(self + ' 的 "Touches" 有看起来是目录但没有以 `/` 结尾的项: ' + looksLikeDir.join(' ')
        + '\n    怎么改：目录一律写成 `src/hooks/`。漏尾斜杠会被当成一个叫这个名字的文件，'
        + 'stage-3 的断言⑥ 匹配到零个文件、于是把该票所有改动都判成越界，'
        + '而报错原因和真实原因对不上。若它确实是无扩展名的文件（如 `Makefile`），'
        + '写成 `./Makefile` 或补上路径分隔以外的可辨识后缀。');
      process.exit(FAIL);
    }
    const backslash = items.filter((s) => s.includes('\\'));
    if (backslash.length > 0) {
      err(self + ' 的 "Touches" 用了反斜杠路径分隔符: ' + backslash.join(' ')
        + '\n    怎么改：一律用正斜杠——git 输出的路径永远是正斜杠，反斜杠写法永不匹配。');
      process.exit(FAIL);
    }
  }
}

// 环检测：有环时受影响的票永远不够格，frontier 空转（表现为"卡住"而非报错），
// 并行批次计算还可能把环上两票误判成互不依赖。
const WHITE = 0, GRAY = 1, BLACK = 2;
const color = new Map(nums.map((n) => [n, WHITE]));
const stack = [];
let cycle = null;
function dfs(n) {
  color.set(n, GRAY);
  stack.push(n);
  for (const d of deps.get(n) || []) {
    if (color.get(d) === GRAY) { cycle = stack.slice(stack.indexOf(d)).concat(d); return true; }
    if (color.get(d) === WHITE && dfs(d)) return true;
  }
  stack.pop();
  color.set(n, BLACK);
  return false;
}
for (const n of nums) {
  if (color.get(n) === WHITE && dfs(n)) break;
}
if (cycle) {
  err('"Blocked by" 存在循环依赖: ' + cycle.join(' → ')
    + '\n    怎么改：打断这个环。环上的票永远不满足"所有 Blocked by 已勾"，stage-3 的 frontier'
    + '会算不出任何够格票而空转；并行批次计算也可能把环上两票误判成互不依赖而同时派发。');
  process.exit(FAIL);
}

process.exit(PASS);
