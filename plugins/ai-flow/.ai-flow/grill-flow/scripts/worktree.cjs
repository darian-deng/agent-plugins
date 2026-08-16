#!/usr/bin/env node
// grill-flow stage-3 并行票的 worktree 开/收。
//
// 存在理由：worktree 的生命周期有 5 件固定动作（位置、gitignore、分支命名、装依赖、
// 收口前的干净断言），它们是动作不是判断。写进提示词就是让编排器每批次记 5 条纪律；
// 放这里，提示词只需要「开票用 `open`、收票用 `close`」。
//
//   node scripts/worktree.cjs open   <flow_id> <T<n>|R<n>> [--install "<cmd>"]   ← open 不认 --no-install
//   node scripts/worktree.cjs sync   <flow_id> <T<n>|R<n>> [--no-install]
//   node scripts/worktree.cjs close  <flow_id> <T<n>|R<n>> [--keep] [--no-install]
//   node scripts/worktree.cjs status <flow_id>
//
// status：一屏看全四条车道（ahead / dirty / 是否 HEAD 后继 / 待补依赖）。存在理由是这张表
//   原先只活在主 session 的上下文里，靠记忆维护它的代价实测是漏 sync 的往返、六次依赖陈旧
//   假红、以及一次「把验证和 close 串成一条命令链」导致地板红的票被 ff 进主分支。
//   /clear 重入时的「逐票判相位」也从读一堆文件变成读这一条命令。
//
// 依赖漂移（sync / close 都做）：树是长驻的而别的票会改依赖清单，改动经 rebase / ff 进来
//   之后 `node_modules` 就陈旧了。默认自动补装；`--no-install` 只报不装。理由见 `installIn`。
//
// 名字收两种形态，选哪种由 references/execution-unit.md 判定（车道模式的动作差异在
//   references/lane-mode.md），本脚本对两者一视同仁：
//   - `T<n>` 一票一树：树的生命周期 = 一票，close 即拆。
//   - `R<n>` 一组一车道：树长驻，组内每票各自 commit、各自 `close --keep` 回合，末票才真拆。
//     存在理由是装依赖的成本随**开树次数**走而不是随票数走——票多时一票一树要付 N 次
//     装依赖（monorepo + native addon 那种，单次就是分钟级），而并行度反被批次上限压住。
//
// open：建 `<repo 同级>/<repo 名>.ai-flow-worktrees/<flow_id>-<name>`、
//       分支 `wt/<flow_id>-<name>`、装依赖。
//   - 分支名带 flow_id：票号跨 flow 复用，`wt/T1` 会撞上上一个 flow 的残留分支
//     （`fatal: a branch named 'wt/T1' already exists`）。
//   - **位置必须在仓库之外**（这条是 0.50.0 改的，之前放在 `<锚点>/.worktrees/`）：
//     模块解析（node 与 tsc 都是从当前文件逐级向上找 `node_modules`）在 worktree 嵌在
//     主检出内部时会**走出 worktree**、落到主检出的 `node_modules`，于是同一个包出现两个
//     物理路径 —— 对 TypeScript 那就是两份互不相关的同名类型，报一堆「同名但不兼容」，
//     与被测改动毫无关系，却会卡住 pre-commit hook、让碰到那些包的票全都提交不了。
//     实测（pnpm workspace，落点在 `apps/desktop/.worktrees/`）：车道里 web4 typecheck
//     71 个错、`tsc --listFilesOnly` 能看到主树与车道**两份** `@types/react`；把落点搬到
//     仓库同级后，同一条命令 0 错、只剩车道自己那一份。这不是环境问题，是选址的必然后果。
//     ⚠️ 别把它当成「TS 收集祖先 node_modules/@types」那种解释——那条路径（typeRoots
//     自动引入）单独复现不出这个错，真正越界的是**import 解析**。查证手段：在 worktree 里
//     `tsc -p <config> --noEmit --listFilesOnly | grep <包名> | sort -u`，出现两个不同
//     前缀的路径就是越界了。
//     原先放仓库内的理由（引擎 walk-up 靠继续上溯才能从 worktree 走到主仓锚点）已经
//     不成立：引擎现在改成问 git 要主检出的对应目录（`mainCheckoutCounterpart`），
//     与 worktree 放在哪无关。放仓库外顺带不再需要 gitignore（`git add -A` 碰不到它）。
//   - 旧落点仍然认：`sync` / `close` 先看新落点，不在就找 `<锚点>/.worktrees/<name>`。
//     升级前开出去的树还在跑，认不出来就等于让它们无法收口。
//   - 装依赖：新 worktree 是干净 checkout，`node_modules` / 构建缓存都在 gitignore 里
//     一个都没有。不装，子代理跑不了客观地板。探测与执行同目录，见 `detectInstall`。
//   - 派发路径：monorepo 子项目锚点下 worktree 根 ≠ 项目根，两个都要打印，见 `wtAnchor`。
//
// sync：把本票分支 rebase 到当前需求分支之上。存在的唯一理由是**不要在提示词里写
//   `git rebase <主分支>`**——那是个占位符，子代理很可能照字面跑 `git rebase main`，
//   把本票 replay 到 main 之上，此后 ff 永久失败而它自己看不出错在哪。需求分支名由
//   本脚本从主仓 `git branch --show-current` 取。
//
// close：四条前置断言 → `git merge --ff-only` 回合 → `git worktree remove`（`--keep` 时不拆）。
//   - `--keep` 的存在理由是**让断言照跑**：车道模式下想「合了但不拆」，不给这个开关就只能
//     在主树手敲 `git merge --ff-only`，于是组内每一票的回合都绕过了下面四条断言——而它们
//     恰好是最值钱的那几条。组内末票收口时去掉 `--keep`，让机器门⑤ 的「无残留 worktree」
//     如常生效（忘了去掉是 fail-closed：门会拦，不会静默放行）。
//   - **worktree 干净**：里面的未追踪文件（fixture / migration / 运行时读的 JSON）
//     不在任何 commit 里。主树的 `git add -A` 看不到另一棵工作树，所以 `--force`
//     拆掉就是永久丢失，而 stage-3 机器门也发现不了。
//   - **本票分支上无 merge commit**：`--ff-only` 只保证主树这一侧不做合并，**不保证
//     内容不丢**——丢内容的 merge 可以发生在票分支上（子代理在自己 worktree 里
//     `git merge -X ours` 适配），ff 只是把它照单收进主历史。实测：T1 的改动被静默
//     删除而 ff 返回 0。机器门 ④ 兜得住，但那是整个 stage 跑完才报、补救要 reset 重提；
//     这里在回合前就有全部信息，所以就地拦。
//   - **主树无非记账改动**：子代理若把改动写到了主树（相对路径 + cwd 恰好是主仓时
//     引擎那道守卫不触发），worktree 里的 commit 就是缺内容的。这是那种情形唯一的
//     机器防线。
//   - **本票分支相对 HEAD 有 commit**：零 commit 的分支 ff 会返回 "Already up to date"，
//     拆掉后看起来像"这票交付了"，实则一行代码没有。
'use strict';

const { execFileSync } = require('child_process');
const { existsSync, lstatSync, unlinkSync, readFileSync, writeFileSync, statSync } = require('fs');
const { createHash } = require('crypto');
const { join, dirname, basename, relative } = require('path');

const flowDir = join(__dirname, '..');
// flow 锚点（= `{{project_root}}`）。**不是 git 根**：monorepo 子项目锚点下两者不同，
// 本插件自己就是那种结构（锚点 plugins/ai-flow、git 根是仓库根）。下面凡是要区分的地方
// 都显式问 git，别拿这个变量当仓库根用。
const repoRoot = join(flowDir, '..', '..');

const die = (m) => { process.stderr.write('❌  ' + m + '\n'); process.exit(1); };
const say = (m) => process.stdout.write(m + '\n');

// `trimEnd` 而不是 `trim`：`git status --porcelain` 的状态位**是有意义的前导空格**
// （` M path` = 工作区已改、索引未改）。整段 trim 只吃掉首行那一个空格，于是下面按
// `slice(3)` 取路径时首行错位一格（`apps/…` 变成 `pps/…`），记账豁免前缀匹配不上——
// 结果是 stage-3 明文声明为正常的「主树只有 docs/grill-flows/ 下的记账改动」被判成
// 「子代理把代码写进了主树」，从第二票起每次回合都被拒，而报错说的是没发生过的事。
// （第一票躲得过：那时记账文件还是未追踪的 `?? `，没有前导空格。）
// `core.quotePath=false`：默认 git 会把非 ASCII 路径转义成 `"docs/\347\234\237…"`（连引号一起），
// 于是 `slice(3)` 取到的是 `"docs/…` 而不是 `docs/…`，记账豁免前缀匹配不上——与已修掉的
// `trim()` off-by-one 是同一形态、同一受害者：主树只有记账改动却被判成「子代理写错了地方」，
// 从那一票起每次回合都被拒。本 flow 的记账文件迟早会出现中文名（`真机验证清单.md` 之类）。
// `maxBuffer`：默认 1MB，大仓的 `status -uall` / `log` 可能溢出，而溢出后 `gitQuiet` 只会
// 返回 ok:false，下面几条断言就静默变成空操作。gate-stage-3 早就设了 4MB，这里对齐。
function git(args, opts = {}) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: opts.cwd || repoRoot,
    encoding: 'utf-8',
    stdio: 'pipe',
    maxBuffer: 4 * 1024 * 1024,
  }).trimEnd();
}
function gitQuiet(args, opts = {}) {
  try { return { ok: true, out: git(args, opts) }; }
  catch (e) { return { ok: false, out: String((e.stderr || e.stdout || e.message || '')).trim() }; }
}

// porcelain 一行 = 2 位状态 + 1 空格 + 路径；重命名/复制条目的路径部分是 `old -> new`，
// 前缀匹配必须落在 **new** 上（改名的去向才决定它算不算记账文件）。
function porcelainPath(line) {
  const p = line.slice(3);
  const arrow = p.indexOf(' -> ');
  return arrow === -1 ? p : p.slice(arrow + 4);
}

// ── 跑错脚本副本的防线 ──
// `.ai-flow/` 是被 git 追踪的，所以**每一棵 worktree 里都有一份完整的脚本副本**，而
// `repoRoot` 是从 `__dirname` 推的——跑车道里那份，所有 git 操作就都作用在那棵树上。
// 另外两个脚本天然 fail-closed（它们 require `state/active.json`，而 `state/` 被 gitignore、
// 副本里根本没有），本脚本的 flowId 来自 argv、不读 state，于是缺这道保险。实测跑副本：
// `sync`/`close` 死在「<路径> 不存在」——响亮但**方向指反**（真实原因是脚本副本选错，
// 报错却在说票号写错）；`open` 更糟，静默在车道目录旁边再建一层 worktree 并占掉分支名。
if (!existsSync(join(flowDir, 'state', 'active.json'))) {
  const probe = gitQuiet(['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel']);
  let hint = '';
  if (probe.ok) {
    const [commonDir, wtRoot] = probe.out.split('\n');
    if (commonDir && wtRoot) {
      const mainRoot = dirname(commonDir);
      const rel = relative(wtRoot, repoRoot);
      if (!rel.startsWith('..')) {
        hint = '\n    应该跑的是主检出那一份：'
          + join(mainRoot, rel, '.ai-flow', basename(flowDir), 'scripts', basename(__filename));
      }
    }
  }
  die('这份脚本副本没有 `state/active.json`，说明它不是主检出里那一份（每棵 worktree 都有一份'
    + '被 git 追踪的同名副本，而本脚本的所有 git 操作都作用在它自己所在的那棵树上）。'
    + '\n    继续跑下去：`open` 会静默在错误位置建树并占掉分支名，`sync`/`close` 会报'
    + '「<路径> 不存在」——那个报错的方向是反的，真实原因就是这一条。' + hint);
}

// 锚点相对 git 根的前缀（`plugins/ai-flow/`，锚点就是 git 根时为空串）。
// worktree 是**整仓** checkout，所以 worktree 里的项目根是 `<wtPath>/<anchorPrefix>`。
// 尾斜杠去掉：`join()` 会把它带进拼出来的目录名，派发给子代理的 `<WT>` 就成了 `…/proj/`，
// 契约里再拼 `<WT>/src/x` 会得到双斜杠。`bookkeeping` 那处要的是带尾斜杠的前缀，自己补。
function anchorPrefix() {
  // 必须看 ok：`gitQuiet` 失败时 out 是 **stderr 文本**，当成前缀会拼出垃圾路径。
  const r = gitQuiet(['rev-parse', '--show-prefix']);
  return r.ok ? r.out.replace(/\/$/, '') : '';
}

// 装依赖的**探测目录与执行目录必须是同一个**，且必须在 worktree 内部。
// 原版两处都错：探测基准取 flow 锚点（主树里的那个），执行 cwd 取 worktree 根。锚点 = git 根
// 时看不出问题，monorepo 子项目锚点下就分叉了。实测后果（本插件自己的仓库）：锚点有
// `package-lock.json` → 探到 `npm ci` → 在 worktree 根跑，那里没有 package.json，于是 npm
// 沿父目录上溯找到了**主树**的 `<锚点>/package.json`，把主树的 node_modules 整个重装掉，
// 而 worktree 里一个依赖都没装成。主树正是 stage-3 的调度中心，这一步是在它脚下换轮子；
// 更隐蔽的是 node 的模块解析同样会上溯，所以 worktree 里的测试「跑得起来」——用的是主树依赖。
// 反向布局（锚点是 pnpm workspace 的子包、锁文件在 git 根）也错：探到 `npm install` 在整仓
// checkout 上跑，`workspace:*` 协议 npm 不认。
//
// 规则：候选目录 = worktree 里的项目根 → 逐级上溯到 worktree 根，**就近**取第一个带锁文件的
// （锚点自带锁文件的独立包胜出，锁文件在仓库根的 workspace 也对）；一个锁文件都没有才退到
// 就近的 package.json。
const LOCKS = [
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['yarn.lock', 'yarn install --frozen-lockfile'],
  ['package-lock.json', 'npm ci'],
];
function installCandidates(wtRoot, prefix) {
  const dirs = [];
  let cur = prefix ? join(wtRoot, prefix) : wtRoot;
  // 以 wtRoot 收尾：prefix 由 git 给出，cur 必然在 wtRoot 之下，循环有界。
  while (cur !== wtRoot && cur !== dirname(cur)) { dirs.push(cur); cur = dirname(cur); }
  dirs.push(wtRoot);
  return dirs;
}
function detectInstall(dirs) {
  for (const d of dirs) {
    for (const [file, cmd] of LOCKS) if (existsSync(join(d, file))) return { cmd, cwd: d };
  }
  for (const d of dirs) if (existsSync(join(d, 'package.json'))) return { cmd: 'npm install', cwd: d };
  return null;
}

// ── 依赖漂移 ──
// 存在理由：`open` 装一次依赖之后树是长驻的，而**别的**票会改依赖清单。那些改动经 `sync`
// （rebase 进车道）或 `close`（ff 进主树）进来时，`node_modules` 就相对锁文件陈旧了。
// 失效形态不是「报缺依赖」而是**伪装成大规模回归**：vitest 把「文件加载失败」计成「文件
// 失败」，于是失败文件数远大于失败用例数、总用例数明显变少，看着像天塌了。实测一次在主树上
// 报出 231 个文件失败（补装后 1619 文件全绿），另一次让一张实际正常的票被判成有缺陷。
// 这条纪律原先只写在 stage-3 提示词里，实测在同一次运行里失效 6 次——最后一次是刚把这条
// 判据整段讲给开发者听的那个 agent，10 分钟后自己踩的。所以它必须在脚本里，不在提示词里。
const DEP_MANIFESTS = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'package.json'];
function depsChanged(fromSha, toSha, cwd) {
  const d = gitQuiet(['diff', '--name-only', fromSha, toSha], { cwd });
  if (!d.ok) return null; // 说不清 → 由调用处报出来，不静默当成「没变」
  return d.out.split('\n').map((s) => s.trim()).filter((f) => f && DEP_MANIFESTS.includes(basename(f)));
}
// 该工作树「最后一次有动静」距今多少分钟。存在理由：子代理停没停，**不能问它自己**——
// 它停住时给主 session 发的通知与正常交付一样是 `completed`，正文才是差别，而正文会被读错
// （实测主 session 把「Waiting for the full web4 test suite」读成了「它还在跑」，然后等了
// 一小时零七分钟）。工作树的物理变化是唯一不依赖自我报告的信号：一条声称在飞的车道，
// 若它的 HEAD 和全部改动文件都几十分钟没动过，那它就是停了。
function idleMinutes(wtRoot) {
  let newest = 0;
  const st = gitQuiet(['status', '--porcelain', '-uall'], { cwd: wtRoot });
  if (st.ok) {
    for (const line of st.out.split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = statSync(join(wtRoot, porcelainPath(line))).mtimeMs;
        if (m > newest) newest = m;
      } catch { /* 已删除的条目 stat 不到，跳过 */ }
    }
  }
  const head = gitQuiet(['log', '-1', '--format=%ct'], { cwd: wtRoot });
  if (head.ok && head.out) newest = Math.max(newest, Number(head.out) * 1000);
  if (newest === 0) return null;
  return Math.max(0, Math.round((Date.now() - newest) / 60000));
}

// 装依赖的持久标记：记录「上次装成功时，各依赖清单的内容 sha」。判据用它而不是「本次
// rebase 带进了什么」，是因为后者对「上一次装失败、这次重跑」不成立——那种情况下本次
// rebase 什么也没带进来，可树里的 node_modules 依然是错的。文件落在 worktree 根、
// 名字带点前缀，`git status --porcelain` 会把它算成未追踪 → close 的干净断言会拒。
// 所以写进 `.git/`（worktree 的私有 git 目录，永远不被 checkout、不被 status 看见）。
function depsStampPath(root) {
  const d = gitQuiet(['rev-parse', '--path-format=absolute', '--git-dir'], { cwd: root });
  return d.ok && d.out ? join(d.out, 'ai-flow-deps-stamp') : null;
}
function depsFingerprint(root, prefix) {
  const detected = detectInstall(installCandidates(root, prefix));
  if (!detected) return null;
  const files = DEP_MANIFESTS.map((f) => join(detected.cwd, f)).filter((f) => existsSync(f));
  if (files.length === 0) return null;
  return files.map((f) => `${basename(f)}:${createHash('sha1').update(readFileSync(f)).digest('hex')}`).join(' ');
}
// 装成功之后记下当前指纹。
function stampDeps(root) {
  const stampFile = depsStampPath(root);
  const now = depsFingerprint(root, anchorPrefix());
  if (!stampFile || now === null) return;
  try { writeFileSync(stampFile, now); } catch { /* 写不了只是下次多装一次，不是错误 */ }
}

// 唯一该被调用的入口：比对指纹，不一致才装，装成功才更新标记。
function ensureDeps(root, label, noInstall) {
  const prefix = anchorPrefix();
  const stampFile = depsStampPath(root);
  const now = depsFingerprint(root, prefix);
  if (now === null) return;                       // 探不到依赖清单，无从判断
  let prev = null;
  try { if (stampFile && existsSync(stampFile)) prev = readFileSync(stampFile, 'utf-8').trim(); } catch { /* 读不到当没装过 */ }
  if (prev === now) return;
  installIn(root, prefix, label, noInstall);
  if (!noInstall && !installFailed) stampDeps(root);
}

// `root` = 那棵树的仓库根（worktree 根 / git 根），`prefix` = 锚点相对仓库根的位置。
let installFailed = false;
function installIn(root, prefix, label, noInstall) {
  const detected = detectInstall(installCandidates(root, prefix));
  if (!detected) {
    say(`⚠️  ${label}的依赖清单变了，但探测不到装依赖命令——手动补装后再跑测试。`);
    return;
  }
  if (noInstall) {
    say(`⚠️  ${label}的依赖清单变了，按 --no-install 跳过。**跑任何测试前先手动补装**：`
      + `\n      cd ${detected.cwd} && ${detected.cmd}`
      + `\n    不补装的症状是大批「文件加载失败」，看起来像大规模回归而不是缺依赖。`);
    return;
  }
  say(`${label}的依赖清单变了，补装: ${detected.cmd}\n  cwd:  ${detected.cwd}`);
  try {
    execFileSync(detected.cmd, { cwd: detected.cwd, shell: true, stdio: 'inherit' });
  } catch (e) {
    // 不回退 rebase / ff（回退比手动补装贵得多），但**退出码要如实**：装依赖失败之后这棵树
    // 跑任何测试都会得到一批「文件加载失败」的假红，而 `close && npm test` 这种链子只看
    // 退出码。exit 0 等于亲手制造本脚本自己在警告的那类陷阱。
    process.stderr.write(`⚠️  补装失败，**跑测试前必须手动补上**（否则会看到一批假红）：`
      + `\n      cd ${detected.cwd} && ${detected.cmd}\n    ${String(e.message || e)}\n`);
    process.stderr.write('    ⚠️ 本脚本会以非零退出——**回合本身已经完成且不可逆**，非零只是为了'
      + '打断 `close && <跑测试>` 这类命令链（在没装好依赖的树上跑测试会得到一批假红）。'
      + '⛔ 不要因此重跑 close：那时票已在需求分支上，会报「这票没有交付物」。\n');
    installFailed = true;
  }
}

const [, , cmd, flowId, ticket, ...rest] = process.argv;
const noInstall = process.argv.includes('--no-install');
const USAGE = '用法：node scripts/worktree.cjs open  <flow_id> <T<n>|R<n>> [--install "<cmd>"]\n'
  + '      node scripts/worktree.cjs sync  <flow_id> <T<n>|R<n>> [--no-install]\n'
  + '      node scripts/worktree.cjs close <flow_id> <T<n>|R<n>> [--keep] [--no-install]\n'
  + '      node scripts/worktree.cjs status <flow_id>';
if (!cmd || !flowId) die(USAGE);
if (cmd !== 'status' && !ticket) die(USAGE);
// `R<n>` = 一组一条长驻车道。⛔ 不要放宽成任意字符串：这个名字进 worktree 路径与分支名，
// 而机器门⑤ 是按 `.worktrees/<flow_id>-` 前缀查残留的，形态失控会让残留查不出来。
if (cmd !== 'status' && !/^[TR]\d+$/.test(ticket)) {
  die('名字应形如 T3（一票一树）或 R1（一组一车道），收到: ' + ticket);
}
// flowId 同样进路径拼接与分支名。含 `/` 或 `..` 会让落点跑出 lanesRoot，并让机器门⑤ 与
// abort 的「按 `<lanesRoot>/<flow_id>-` 前缀查残留」失效——那两处失效是静默的。
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(flowId)) {
  die('flow_id 只允许字母数字与 . _ -（它进路径与分支名，含 / 或 .. 会让机器门⑤ 查不出残留），收到: ' + flowId);
}

const name = `${flowId}-${ticket}`;
const branch = `wt/${name}`;

// 落点在仓库**同级**目录（理由见文件头）。gitRoot 问 git 而不是从锚点推：monorepo
// 子项目锚点下两者不同，按锚点算会把落点放回仓库内、把上面那个缺陷带回来。
const gitRootProbe = gitQuiet(['rev-parse', '--show-toplevel']);
const gitRoot = gitRootProbe.ok && gitRootProbe.out ? gitRootProbe.out : repoRoot;
const lanesRoot = join(dirname(gitRoot), basename(gitRoot) + '.ai-flow-worktrees');
const wtPathCurrent = join(lanesRoot, name);
// 0.50.0 之前的落点。`open` 只用新的；`sync`/`close` 要认旧的，否则升级前开出去、
// 还在跑的那些树永远收不了口（脚本会说「不存在，已收口过？」，方向完全指错）。
const wtPathLegacy = join(repoRoot, '.worktrees', name);
const wtPath =
  cmd === 'open' || existsSync(wtPathCurrent) ? wtPathCurrent
  : existsSync(wtPathLegacy) ? wtPathLegacy
  : wtPathCurrent;
const isLegacyPath = wtPath === wtPathLegacy;

if (cmd === 'status') {
  // 存在理由：这张表原先只活在主 session 的上下文里——四条车道 × 当前票 × 是否脏 ×
  // 是否还是 HEAD 的直接后继 × 依赖新不新。靠记忆维护它的代价实测是：漏 sync 后 close
  // 报「不是直接后继」的往返、把验证和 close 串成一条命令链导致地板红的票被 ff 进主分支、
  // 以及六次依赖陈旧假红。/clear 重入时的「逐票判相位」也从读一堆文件变成读这一条命令。
  const target = gitQuiet(['branch', '--show-current']);
  if (!target.ok || !target.out) die('无法确定需求分支（主仓处于 detached HEAD？）。');
  // ⛔ 这里不 prune：`status` 的名字承诺只读，而 `git worktree prune` 会**删掉登记**。
  // 目录只是临时不可达（外挂盘没挂、被人移走）时，prune 之后连 `worktree repair` 都救不回来。
  const listed = gitQuiet(['worktree', 'list', '--porcelain']);
  if (!listed.ok) die('git worktree list 失败:\n' + listed.out);
  const prefixes = [join(lanesRoot, flowId + '-'), join(repoRoot, '.worktrees', flowId + '-')];
  const paths = listed.out.split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
    .filter((p) => prefixes.some((pre) => p.startsWith(pre)));
  if (paths.length === 0) {
    say(`需求分支 ${target.out}：本 flow（${flowId}）名下没有 worktree。`);
    process.exit(0);
  }
  say(`需求分支 ${target.out}`);
  for (const p of paths.sort()) {
    const nm = basename(p);
    const br = `wt/${nm}`;
    const ahead = gitQuiet(['rev-list', '--count', `HEAD..${br}`]);
    const st = gitQuiet(['status', '--porcelain', '-uall'], { cwd: p });
    const desc = gitQuiet(['merge-base', '--is-ancestor', 'HEAD', br]).ok;
    // 「待补依赖」= 该树还没 rebase 进来的那些 commit 里动过的依赖清单。已经是 HEAD 后继
    // 的树没有待补部分；不是后继的树，sync 之后就会把这些带进来、`node_modules` 随即陈旧。
    const missing = desc ? [] : (depsChanged(br, 'HEAD') || []);
    say(`  ${nm.slice(flowId.length + 1) || nm}  ${br}`
      + `  ahead:${ahead.ok ? ahead.out : '?'}`
      + `  dirty:${st.ok ? (st.out ? 'YES' : 'no') : '?'}`
      + `  是否HEAD后继:${desc ? 'yes' : 'NO(先 sync)'}`
      + `  待补依赖:${missing.length > 0 ? [...new Set(missing.map((f) => basename(f)))].join(',') : 'no'}`
      + `  静默:${(() => { const i = idleMinutes(p); return i === null ? '?' : i + '分钟'; })()}`);
  }
  say(`\n  静默 → 该树最近一次变化（HEAD 时间与全部改动文件 mtime 取最新）距今多久。`
    + `**声称在飞、却静默 ≥30 分钟 = 那个子代理已经停了**，不是在思考——去唤醒它，别继续等。`
    + `\n  dirty:YES → 该树有未提交/未追踪的东西，close 会拒；先 amend 进本票那笔或删掉。`
    + `\n  是否HEAD后继:NO → 别的车道回合过了，本车道 sync 之后才能 close。`
    + `\n  待补依赖 非 no → sync 会把这些锁文件带进来，之后必须重装（脚本会自动装，除非 --no-install）。`);
  process.exit(0);
}

if (cmd === 'open') {
  // gitignore 检查：漏了它，worktree 目录会被 stage-4 的 `git add -A` 吞成 gitlink
  // （`warning: adding embedded git repository`，不是 error，所以没人会注意到）。
  // 问 git 而不是自己读 .gitignore 正则：规则可以写成 `/.worktrees/`、`.worktrees/**`、
  // `**/.worktrees/`，也可以在 `.git/info/exclude` 里，还可能写在 git 根而锚点是
  // monorepo 子项目（`add.ts` 就是特意写到 git 根的）——任何自己实现的匹配都会误拒。
  // `check-ignore` 对不存在的路径同样判得对，但要带下级路径（裸目录名不行）。
  // 只在落点**落在仓库里**时才需要这条检查——新落点在仓库同级，`git add -A` 碰不到它。
  // 保留是因为落点可以被上面那串回退逻辑推回仓库内（拿不到 git 根时），那种情况下
  // 漏 gitignore 的后果照旧。
  const insideRepo = !relative(gitRoot, wtPath).startsWith('..');
  if (insideRepo) {
    const ignored = gitQuiet(['check-ignore', '-q', join(wtPath, '.probe')]).ok;
    if (!ignored) {
      die('落点在仓库内且不在 .gitignore 里。先加上再开 worktree——否则 stage-4 收尾的 '
        + '`git add -A` 会把整个 worktree 目录当嵌套仓库吞进 squash commit（只 warning 不报错，'
        + '结果是一个空的 gitlink 条目、内容一个都没进去）。');
    }
  }
  // 选址哨兵：模块解析会从 worktree 里逐级向上找 `node_modules`，所以落点**任一祖先**
  // 目录有 node_modules，那一份就会被解析进来 —— 同一个包两个物理路径，TypeScript 报
  // 「同名但不兼容」（实测形态见文件头）。落点选在仓库同级正是为了避开这个，但父目录本身
  // 若也是个 node 项目，问题会以同样的形态回来。只警告不阻断：它取决于开发者的目录布局。
  const polluted = [];
  for (let d = dirname(wtPath); ; d = dirname(d)) {
    if (existsSync(join(d, 'node_modules'))) polluted.push(d);
    if (dirname(d) === d) break;
  }
  if (polluted.length > 0) {
    say(`⚠️  落点的祖先目录里有 node_modules：${polluted.join(' ')}\n`
      + `    模块解析会向上走到它们，于是同一个包出现两个物理路径，worktree 里的 typecheck 会报\n`
      + `    一批「同名但不兼容」，与被测改动无关。查证：在 worktree 里跑\n`
      + `    \`tsc -p <config> --noEmit --listFilesOnly | grep <包名> | sort -u\`，两个前缀就是越界。\n`
      + `    处置：把那些 node_modules 移走，或把仓库挪到一个干净的父目录下。`);
  }
  if (existsSync(wtPath)) die(`${wtPath} 已存在。若是上一轮残留：先 close，或 \`git worktree remove ${wtPath}\`。`);

  const exists = gitQuiet(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
  if (exists) {
    die(`分支 ${branch} 已存在（上一轮 /clear 后的残留？）。\n`
      + `    若它就是本票未收口的工作：\`git worktree add ${wtPath} ${branch}\` 复用它，别新建。\n`
      + `    若确定要丢弃：\`git branch -D ${branch}\` 后重跑。`);
  }

  const add = gitQuiet(['worktree', 'add', wtPath, '-b', branch]);
  if (!add.ok) die('git worktree add 失败:\n' + add.out);
  say(`worktree: ${wtPath}\nbranch:   ${branch}`);

  const prefix = anchorPrefix();
  const wtAnchor = prefix ? join(wtPath, prefix) : wtPath;
  const detected = detectInstall(installCandidates(wtPath, prefix));
  const flagIdx = rest.indexOf('--install');
  // `--install` 只覆盖命令，不覆盖目录：探测出来的那个目录就是「依赖清单所在处」，
  // 手写命令同样该在那儿跑。真要换目录，命令里自带 `cd`（下面是 shell:true）。
  const installCmd = flagIdx !== -1 ? rest[flagIdx + 1] : detected && detected.cmd;
  const installCwd = (detected && detected.cwd) || wtAnchor;
  if (installCmd) {
    say(`装依赖: ${installCmd}\n  cwd:  ${installCwd}`);
    try {
      execFileSync(installCmd, { cwd: installCwd, shell: true, stdio: 'inherit' });
      // 落指纹：`sync` / `close` 靠它判「这棵树的 node_modules 还对不对」。不落的话首次
      // sync 会把「从没装过」误判成「清单变了」而重装一次（慢但无害），更要紧的是
      // 「上次装失败」与「装过且是新的」在指纹上分不开。
      stampDeps(wtPath);
    } catch (e) {
      die(`装依赖失败（worktree 已创建、可手动补）: ${installCmd}\n    cwd: ${installCwd}\n    ${String(e.message || e)}`);
    }
  } else {
    say('未探测到依赖清单，跳过装依赖。若该票需要构建/测试，手动装。');
  }
  // 派发给子代理的 `<WT>` 必须是 worktree 里的**项目根**，不是 worktree 根：契约里的
  // `<WT>/…` 是拿来和 `Touches` 拼绝对路径的，而 `Touches` 的基准是 flow 锚点。
  // monorepo 子项目锚点下给了 worktree 根，子代理就会在整仓根凭空建出一层 `src/…`——
  // 而机器门⑥ 抓不到：它把 git 根相对路径剥掉锚点前缀再比，`src/x` 剥不掉、原样匹配
  // `Touches: src/`，于是文件建错了层却全绿。锚点外的包（monorepo 里别的 workspace）
  // 用 worktree 根拼。
  if (wtAnchor !== wtPath) {
    say(`\n派发给子代理的绝对路径：`
      + `\n  <WT>（项目根，和 Touches 同基准，拼路径用这个）：${wtAnchor}`
      + `\n  <WT_ROOT>（worktree 根，锚点外的包用它，如 monorepo 别的 workspace）：${wtPath}`);
  } else {
    say(`\n派发给子代理时给绝对路径：${wtPath}`);
  }
  process.exit(0);
}

if (cmd === 'sync') {
  if (!existsSync(wtPath)) die(`${wtPath} 不存在（先 open）。`);
  const target = gitQuiet(['branch', '--show-current']);
  if (!target.ok || !target.out) die('无法确定需求分支（主仓处于 detached HEAD？）。');
  if (target.out === branch) die(`主仓当前就在 ${branch} 上——需求分支被切走了，先切回需求分支。`);
  if (gitQuiet(['merge-base', '--is-ancestor', target.out, branch], { cwd: wtPath }).ok) {
    say(`${target.out} 已经是 ${branch} 的祖先，无需 rebase。`);
    // 依赖检查不能跟着早退：上一次 sync 的自动补装可能失败了（那时只警告、退出码非零由
    // close 承担），人重跑 sync 想再试一次，走到这里就什么都不做了——而 `status` 对
    // 「已是 HEAD 后继」的树恒报「待补依赖:no」，两条提示渠道同时说干净。
    ensureDeps(wtPath, '这棵车道树', noInstall);
    process.exit(installFailed ? 1 : 0);
  }
  // 先断言干净：rebase 遇到未暂存改动时报的是 "cannot rebase: You have unstaged
  // changes"，而下面的失败分支会把它当成冲突、让人去跑 `rebase --continue`——那时根本
  // 没有 rebase 在进行中，只会得到 "No rebase in progress"。
  const wtSt = gitQuiet(['status', '--porcelain'], { cwd: wtPath });
  if (wtSt.ok && wtSt.out.length > 0) {
    die(`worktree 里有未提交/未追踪的改动，rebase 无法开始：\n`
      + wtSt.out.split('\n').map((l) => '      ' + l).join('\n')
      + `\n    先处置它们（属于本票 → \`git -C ${wtPath} add\` 并 amend 进本票那笔；是垃圾 → 删掉），再 sync。`);
  }
  // rebase 之前记下这棵树的 HEAD：rebase 之后 `ORIG_HEAD` 也指它，但 `--autostash`
  // 与冲突续跑都会动 `ORIG_HEAD`，自己记下来才稳。
  const beforeSha = gitQuiet(['rev-parse', 'HEAD'], { cwd: wtPath });
  const rb = gitQuiet(['rebase', target.out], { cwd: wtPath });
  if (!rb.ok) {
    die(`rebase 到 ${target.out} 有冲突，需要你在 worktree 里解决：\n      ${rb.out}\n`
      + `    在 ${wtPath} 里解冲突 → \`git -C ${wtPath} rebase --continue\` → 重跑客观地板\n`
      + `    → \`git -C ${wtPath} commit --amend\` 把适配折回本票那笔（保持一票一 commit）→ 再 close。\n`
      + `    别用 \`git merge\`（含 -X ours）适配：内容会被静默丢弃，且机器门 ④ 会在 stage 末尾拦下整轮。`);
  }
  say(`已 rebase 到 ${target.out}。适配后记得重跑客观地板并 \`--amend\` 折回本票那笔`
    + `（⚠️ 宿主会对 \`--amend\` 报一条 [Git Destructive] 安全告警——那是准确判定不是误报，`
    + `因为被改写的那笔通常不是本 agent 创建的。回报里给出「被 amend 的 sha / 它的父提交 / `
    + `本次新增暂存的文件数」三元组，主 session 才能一眼核完而不用重查一遍）。`);
  if (beforeSha.ok) {
    const changed = depsChanged(beforeSha.out, 'HEAD', wtPath);
    if (changed && changed.length > 0) say(`本次 rebase 带进: ${[...new Set(changed)].join(' ')}`);
  }
  // 判据以「装完时的锁文件指纹」为准，不以「本次 rebase 带进了什么」为准——后者对
  // 「上一次装失败、这次重跑 sync」不成立（那时 rebase 什么也没带进来，树却仍然是错的）。
  ensureDeps(wtPath, '这棵车道树', noInstall);
  process.exit(installFailed ? 1 : 0);
}

if (cmd === 'close') {
  if (!existsSync(wtPath)) die(`${wtPath} 不存在（已收口过？或 flow_id/票号写错）。`);

  // 主仓在哪条分支上：`sync` 查了，`close` 原先没查——而 `close` 才是不可逆的那个。
  // stage-3 期间主 session 确实会临时切分支（认领无主 commit 之类），此时误跑一次 close，
  // `--ff-only` 在拓扑上照样成立、照样打印「已 fast-forward」、照样把树拆掉，改动却进了
  // 那条临时分支，需求分支上什么都没有。之后机器门③ 会报「已勾 ticket 没有自己的 commit」，
  // 方向对但要人回溯半天才能想到是分支切错。
  const cur = gitQuiet(['branch', '--show-current']);
  if (!cur.ok || !cur.out) die('主仓处于 detached HEAD，拒绝回合——先切回需求分支。');
  if (cur.out === branch) die(`主仓当前就在 ${branch} 上——需求分支被切走了，先切回需求分支再 close。`);
  if (cur.out.startsWith('wt/')) {
    die(`主仓当前在 ${cur.out} 上，这看起来是另一票的车道分支而不是需求分支。`
      + `\n    ff 会把本票合进它、然后把树拆掉，而需求分支上什么都不会有。先切回需求分支。`);
  }

  const st = gitQuiet(['status', '--porcelain', '-uall'], { cwd: wtPath });
  if (!st.ok) die('无法读取 worktree 状态:\n' + st.out);
  if (st.out.length > 0) {
    die(`worktree 里还有未提交/未追踪的东西，先处置再收口：\n`
      + st.out.split('\n').map((l) => '      ' + l).join('\n')
      + `\n    未追踪文件（fixture / migration / 运行时读的 JSON）尤其要当心：它们不在任何 commit 里，`
      + `主树的 \`git add -A\` 看不到另一棵工作树，\`--force\` 拆掉就是永久丢失，而机器门也发现不了。`
      + `\n    属于本票 → 在 worktree 里 \`git add\` 并 amend 进本票那笔 commit；确定是垃圾 → 删掉。`);
  }

  // ff 只保证主树这一侧不做合并，不保证内容不丢：丢内容的 merge 可以发生在票分支上。
  const wtMerges = gitQuiet(['log', '--format=%h %s', '--merges', `HEAD..${branch}`]);
  // fail-closed：这三条断言原先都写成「git 成功了才检查」，git 因任何理由失败（子进程被
  // 信号打断、输出溢出 maxBuffer）时它们静默变成空操作，然后照常 ff。而本脚本的自我定位
  // 就是「四条前置断言」——断言查不了就不能放行。
  if (!wtMerges.ok) die('无法检查票分支上有没有 merge commit，拒绝回合:\n' + wtMerges.out);
  if (wtMerges.out.length > 0) {
    die(`${branch} 上有 merge commit，拒绝回合：\n`
      + wtMerges.out.split('\n').map((l) => '      ' + l).join('\n')
      + `\n    子代理是用 \`git merge\` 而不是 \`rebase\` 做适配的。\`-X ours\` 这类策略在无文本冲突时`
      + `会静默丢弃一侧改动（输出是 "Auto-merging" 而不是 CONFLICT），而 \`--ff-only\` 会把这个结果`
      + `照单收进主历史——机器门 ④ 要到整个 stage 跑完才报，那时只能 reset 重提所有票。`
      + `\n    怎么改：在 worktree 里 \`git rebase --onto\` 摘掉那笔 merge，或 \`git reset --hard\` 回到`
      + `本票那笔实施 commit 后用 \`node scripts/worktree.cjs sync ${flowId} ${ticket}\` 重做适配。`);
  }

  // 子代理把改动写进了主树（相对路径 + cwd 恰好是主仓时，引擎那道守卫不触发）——
  // 那么 worktree 里的 commit 是缺内容的。记账改动是常态、豁免。
  // `-uall`：默认 porcelain 会把整个未追踪目录折叠成一行（`?? docs/`），那种形态匹配不上
  // 下面的豁免，于是 flow 自己的记账首次出现时会被误判成 stray。
  //
  // 豁免前缀要带上锚点在仓库里的位置：porcelain 输出的是 **git 根**相对路径，与 cwd 无关。
  // monorepo 子项目锚点下（本插件自己就是），记账文件显示成
  // `?? plugins/ai-flow/docs/grill-flows/…`，写死 `docs/grill-flows/` 会把它判成 stray，
  // 于是**每一票的 close 都被拒**，而报错说的是"子代理写错了地方"——和真实原因无关。
  const prefix = anchorPrefix();
  // 两类改动在 stage-3 期间属于常态、豁免：
  //   `docs/grill-flows/` — 逐票记账（qc:done / [x] / candidates.md）；
  //   `.ai-flow/`         — flow 定义本身。**运行中升级插件就会产生它**，而那是本 flow
  //                          刻意支持的动作（跑中发现提示词有缺陷，改完立刻生效）。它不能
  //                          单独 commit：机器门③ 要求区间内每笔 commit 都归属某一票，
  //                          一笔「升级 flow 定义」的提交会直接 fail 掉整道门。留在工作树里
  //                          由 stage-4 环节 C 的 squash 一并吸收，和记账走同一条路。
  //                          （`state/` 被 gitignore，本来就不会出现在 status 里。）
  const exempt = [
    (prefix ? prefix + '/' : '') + 'docs/grill-flows/',
    (prefix ? prefix + '/' : '') + '.ai-flow/',
  ];
  const mainSt = gitQuiet(['status', '--porcelain', '-uall']);
  if (!mainSt.ok) die('无法读取主工作树状态，拒绝回合:\n' + mainSt.out);
  const stray = mainSt.out.split('\n')
    .filter((l) => l.trim().length > 0)
    .filter((l) => !exempt.some((b) => porcelainPath(l).startsWith(b)));
  if (stray.length > 0) {
    die(`主工作树有非记账改动，拒绝回合：\n`
      + stray.map((l) => '      ' + l).join('\n')
      + `\n    stage-3 期间主树只该有 \`docs/grill-flows/\`（记账）与 \`.ai-flow/\`（flow 定义）下的改动。出现代码改动，通常是子代理`
      + `用相对路径写文件、而它那次 Bash 调用的 cwd 恰好是主仓（引擎的 drifted 守卫只在 cwd≠主仓时`
      + `触发，那种情况下不拦）——于是改动落在主树、worktree 里的 commit 缺内容。`
      + `\n    怎么改：判断这些改动属于哪票 → 移进该票 worktree 并 amend 进它那笔 commit；`
      + `确属无关 stray → 停下问开发者，别一并吞进本 flow。`);
  }

  const ahead = gitQuiet(['rev-list', '--count', `HEAD..${branch}`]);
  if (!ahead.ok) die('无法确认本票分支相对 HEAD 有没有 commit，拒绝回合:\n' + ahead.out);
  if (ahead.out === '0') {
    die(`${branch} 相对当前 HEAD 没有任何 commit——这票没有交付物。\n`
      + `    ff 对零 commit 分支会返回 "Already up to date" 并成功拆除，看起来像"交付了"，实则一行代码没有。\n`
      + `    怎么改：确实还没做 → 派发子代理实施；确定要放弃 → \`git worktree remove ${wtPath} && git branch -D ${branch}\`。`);
  }

  // 数 commit 不等于有内容：一笔 `--allow-empty` 的提交能过上面那条，也能过机器门
  // 全部七条（⑥ 对空文件集恒真、⑦ 对空集恒不相交），最后落进 squash 的是零字节。
  if (gitQuiet(['diff', '--quiet', 'HEAD', branch]).ok) {
    die(`${branch} 有 commit，但它与当前 HEAD 的内容完全相同——这票的 diff 是空的。\n`
      + `    空提交能过"有没有 commit"和机器门的写集检查（空集不越界、也不与谁相交），`
      + `所以只能在这里拦。\n`
      + `    怎么改：确认该票到底做了什么。改动落在别处（主树？另一票的 worktree？）→ 归位后 amend 进本票那笔；`
      + `确实无需改动 → 这张票本身该撤掉，别用空提交充数。`);
  }

  // ff 之前的主树 HEAD，用来问「这次回合带进了哪些文件」（见下方依赖漂移检查）。
  const ffBase = gitQuiet(['rev-parse', 'HEAD']);
  const ff = gitQuiet(['merge', '--ff-only', branch]);
  if (!ff.ok) {
    // 分因：ff 在拓扑上成立却失败，说明是被本地改动挡住，不是需要 rebase——
    // 那种情况下让人回去 rebase 治不了病，会原地循环。
    const topoOk = gitQuiet(['merge-base', '--is-ancestor', 'HEAD', branch]).ok;
    if (topoOk) {
      die(`ff 在拓扑上成立，但被主工作树的本地改动挡住了：\n      ${ff.out}\n`
        + `    这不是"需要 rebase"，rebase 治不了它。先处置主树里与来袭 commit 冲突的那些文件`
        + `（commit / stash / 删掉），再 close。`);
    }
    die(`\`git merge --ff-only ${branch}\` 失败——本票分支不是当前 HEAD 的直接后继：\n      ${ff.out}\n`
      + `    主分支在本票开出去之后前进了（别的票已回合），而本票还没适配。\n`
      + `    不要在主树上解冲突（那会产生 merge commit，机器门 ④ 会拦）。\n`
      + `    退回该票：\`node scripts/worktree.cjs sync ${flowId} ${ticket}\` → 解冲突 → 重跑客观地板 → `
      + `\`git -C ${wtPath} commit --amend\` 折回本票那笔 → 再 close。`);
  }
  say(ff.out || `已 fast-forward 到 ${branch}`);
  say(`\n✅ ${ticket} 已进入需求分支 ${cur.out}。**这一步不可逆**——退回要 reset 主分支，`
    + `而那时本票 worktree 可能已经拆掉。所以 close 要单独发一条命令、在看过验证输出之后再发，`
    + `别串在 \`测试 && close\` 里：shell 的 && 只看退出码，而假红/假绿下退出码不代表结论。`);

  // ff 把别的票的依赖清单改动带进了主树 —— 收口测试跑在主树上，它一样会陈旧。
  // 实测这一侧比车道那侧还高频（主树 231 个测试文件失败那次就是）。
  if (ffBase.ok) {
    const changed = depsChanged(ffBase.out, 'HEAD');
    if (changed && changed.length > 0) say(`本次回合带进: ${[...new Set(changed)].join(' ')}`);
  }
  ensureDeps(gitRoot, '主工作树', noInstall);

  // 兄弟车道在这一刻全部过期了。原先只提示本车道要 sync，于是「别的车道也得 sync」这件事
  // 靠主 session 记——实测它有时提前批量 sync、有时等到下次 close 报「不是直接后继」才回头补。
  // 更隐蔽的是在陈旧基线上跑地板：绿了，但验的不是将要合入的那个状态。
  const sibList = gitQuiet(['worktree', 'list', '--porcelain']);
  if (sibList.ok) {
    const sibPrefixes = [join(lanesRoot, flowId + '-'), join(repoRoot, '.worktrees', flowId + '-')];
    const stale = sibList.out.split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim())
      .filter((p) => sibPrefixes.some((pre) => p.startsWith(pre)) && p !== wtPath)
      .map((p) => basename(p))
      .filter((nm) => !gitQuiet(['merge-base', '--is-ancestor', 'HEAD', `wt/${nm}`]).ok);
    if (stale.length > 0) {
      say(`\n以下车道已不再是 HEAD 的直接后继，**下一票开工前必须先 sync**：`
        + stale.map((nm) => nm.slice(flowId.length + 1) || nm).join(' ')
        + `\n    不 sync 的两种后果：下次 close 报「不是直接后继」（响亮），或者在陈旧基线上跑地板`
        + `——地板绿了，但它验的不是将要合入的那个状态（静默）。`);
    }
  }

  // 车道模式：合了但不拆，同一棵树继续做本组下一票。断言已经在上面全跑过了——这正是
  // 走这个开关、而不是在主树手敲 `git merge --ff-only` 的理由。
  if (rest.includes('--keep')) {
    say(`按 --keep 保留 ${wtPath} 与分支 ${branch}（车道继续用）。`
      + `\n    下一票开工前先 \`node scripts/worktree.cjs sync ${flowId} ${ticket}\`：别的车道回合过之后，`
      + `本车道不 rebase 就会在下次 close 时报「不是直接后继」。`
      + `\n    ⚠️ 本组末票收口时去掉 --keep，否则机器门⑤ 会拦「未收口的 worktree」。`);
    process.exit(installFailed ? 1 : 0);
  }

  const rm = gitQuiet(['worktree', 'remove', wtPath]);
  if (!rm.ok) die('回合成功，但 `git worktree remove` 失败（分支已合，工作未丢）:\n' + rm.out);

  // 旧落点的兼容软链接：0.50.0 把落点搬出仓库后，手工搬迁的人往往会在旧路径留一个指向新
  // 落点的符号链接（怕还有什么东西按旧路径找车道）。它比看上去贵得多——`.gitignore` 只挡
  // git，挡不住任何遍历文件系统的工具：仓内的扫描器（文档链接检查、导出面比对、路径存在性
  // 校验）会跟着它走进整棵车道树，把同一批文件重扫一遍并因路径基准错位报出一批假失败，而
  // 这些目录在 CI 的干净检出里根本不存在 —— 于是那道闸「在每台开发机恒红、在 CI 恒绿」。
  // 实测真的发生过一次，为它单开了一张票才修掉。只删符号链接本身，绝不碰真目录。
  // ⚠️ 不能用 `existsSync` 前置判断：它**跟随**符号链接，而上一行刚把新落点 remove 掉，
  // 此刻旧路径那个软链接已经悬挂 —— `existsSync` 返回 false，整段被跳过，等于没写。
  // 直接 `lstatSync`（不跟随），不存在时抛异常由 catch 吞掉。
  if (!isLegacyPath) {
    try {
      if (lstatSync(wtPathLegacy).isSymbolicLink()) {
        unlinkSync(wtPathLegacy);
        say(`顺带删掉旧落点的悬挂软链接 ${wtPathLegacy}`
          + `（它被 gitignore、CI 里不存在，但仓内的全树扫描工具会跟着它走进车道树，`
          + `报出一批只在开发机上出现的假失败）。`);
      } else {
        say(`⚠️  旧落点 ${wtPathLegacy} 还存在且**不是**软链接，本脚本不动它。`
          + `\n    若它是真目录：确认里面没有未提交的东西后自行删除——仓内的全树扫描工具会扫进去。`);
      }
    } catch { /* 读不到就算了，这是清理不是断言 */ }
  }
  say(`已拆除 ${wtPath}（分支 ${branch} 保留——stage-3 的重入相位表要靠它区分「已交付未回合」；`
    + `stage-4 收尾 squash 后统一删）`);
  process.exit(installFailed ? 1 : 0);
}

die('未知子命令: ' + cmd + '（只支持 open / sync / close / status）');
