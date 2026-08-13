#!/usr/bin/env node
// grill-flow stage-3 并行票的 worktree 开/收。
//
// 存在理由：worktree 的生命周期有 5 件固定动作（位置、gitignore、分支命名、装依赖、
// 收口前的干净断言），它们是动作不是判断。写进提示词就是让编排器每批次记 5 条纪律；
// 放这里，提示词只需要「开票用 `open`、收票用 `close`」。
//
//   node scripts/worktree.cjs open  <flow_id> <T<n>> [--install "<cmd>"]
//   node scripts/worktree.cjs sync  <flow_id> <T<n>>
//   node scripts/worktree.cjs close <flow_id> <T<n>>
//
// open：建 `<repo>/.worktrees/<flow_id>-T<n>`、分支 `wt/<flow_id>-T<n>`、装依赖。
//   - 分支名带 flow_id：票号跨 flow 复用，`wt/T1` 会撞上上一个 flow 的残留分支
//     （`fatal: a branch named 'wt/T1' already exists`）。
//   - 位置在仓库内：worktree 的 `.ai-flow/` 是 tracked 副本、没有 `state/`，
//     引擎 walk-up 走到这里若不能继续上溯就会 fail-open（已在 state.ts 修）；
//     放仓库内则一定能走到主仓锚点。代价是必须 gitignore（否则 `git add -A`
//     会把它吞成 gitlink，且只是 warning 不报错）——本脚本会检查。
//   - 装依赖：新 worktree 是干净 checkout，`node_modules` / 构建缓存都在 gitignore 里
//     一个都没有。不装，子代理跑不了客观地板。
//
// sync：把本票分支 rebase 到当前需求分支之上。存在的唯一理由是**不要在提示词里写
//   `git rebase <主分支>`**——那是个占位符，子代理很可能照字面跑 `git rebase main`，
//   把本票 replay 到 main 之上，此后 ff 永久失败而它自己看不出错在哪。需求分支名由
//   本脚本从主仓 `git branch --show-current` 取。
//
// close：四条前置断言 → `git merge --ff-only` 回合 → `git worktree remove`。
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
const { existsSync, readFileSync } = require('fs');
const { join } = require('path');

const flowDir = join(__dirname, '..');
const repoRoot = join(flowDir, '..', '..');

const die = (m) => { process.stderr.write('❌  ' + m + '\n'); process.exit(1); };
const say = (m) => process.stdout.write(m + '\n');

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: opts.cwd || repoRoot, encoding: 'utf-8', stdio: 'pipe' }).trim();
}
function gitQuiet(args, opts = {}) {
  try { return { ok: true, out: git(args, opts) }; }
  catch (e) { return { ok: false, out: String((e.stderr || e.stdout || e.message || '')).trim() }; }
}

function detectInstall() {
  if (existsSync(join(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile';
  if (existsSync(join(repoRoot, 'yarn.lock'))) return 'yarn install --frozen-lockfile';
  if (existsSync(join(repoRoot, 'package-lock.json'))) return 'npm ci';
  if (existsSync(join(repoRoot, 'package.json'))) return 'npm install';
  return null;
}

const [, , cmd, flowId, ticket, ...rest] = process.argv;
if (!cmd || !flowId || !ticket) {
  die('用法：node scripts/worktree.cjs open|sync|close <flow_id> <T<n>> [--install "<cmd>"]');
}
if (!/^T\d+$/.test(ticket)) die('ticket 应形如 T3，收到: ' + ticket);

const name = `${flowId}-${ticket}`;
const wtPath = join(repoRoot, '.worktrees', name);
const branch = `wt/${name}`;

if (cmd === 'open') {
  // gitignore 检查：漏了它，worktree 目录会被 stage-4 的 `git add -A` 吞成 gitlink
  // （`warning: adding embedded git repository`，不是 error，所以没人会注意到）。
  // 问 git 而不是自己读 .gitignore 正则：规则可以写成 `/.worktrees/`、`.worktrees/**`、
  // `**/.worktrees/`，也可以在 `.git/info/exclude` 里，还可能写在 git 根而锚点是
  // monorepo 子项目（`add.ts` 就是特意写到 git 根的）——任何自己实现的匹配都会误拒。
  // `check-ignore` 对不存在的路径同样判得对，但要带下级路径（裸目录名不行）。
  const ignored = gitQuiet(['check-ignore', '-q', join(wtPath, '.probe')]).ok;
  if (!ignored) {
    die('`.worktrees/` 不在 .gitignore 里。先加上再开 worktree——否则 stage-4 收尾的 '
      + '`git add -A` 会把整个 worktree 目录当嵌套仓库吞进 squash commit（只 warning 不报错，'
      + '结果是一个空的 gitlink 条目、内容一个都没进去）。');
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

  const flagIdx = rest.indexOf('--install');
  const installCmd = flagIdx !== -1 ? rest[flagIdx + 1] : detectInstall();
  if (installCmd) {
    say(`装依赖: ${installCmd}`);
    try {
      execFileSync(installCmd, { cwd: wtPath, shell: true, stdio: 'inherit' });
    } catch (e) {
      die(`装依赖失败（worktree 已创建、可手动补）: ${installCmd}\n    ${String(e.message || e)}`);
    }
  } else {
    say('未探测到依赖清单，跳过装依赖。若该票需要构建/测试，手动装。');
  }
  say(`\n派发给子代理时给绝对路径：${wtPath}`);
  process.exit(0);
}

if (cmd === 'sync') {
  if (!existsSync(wtPath)) die(`${wtPath} 不存在（先 open）。`);
  const target = gitQuiet(['branch', '--show-current']);
  if (!target.ok || !target.out) die('无法确定需求分支（主仓处于 detached HEAD？）。');
  if (target.out === branch) die(`主仓当前就在 ${branch} 上——需求分支被切走了，先切回需求分支。`);
  if (gitQuiet(['merge-base', '--is-ancestor', target.out, branch], { cwd: wtPath }).ok) {
    say(`${target.out} 已经是 ${branch} 的祖先，无需 rebase。`);
    process.exit(0);
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
  const rb = gitQuiet(['rebase', target.out], { cwd: wtPath });
  if (!rb.ok) {
    die(`rebase 到 ${target.out} 有冲突，需要你在 worktree 里解决：\n      ${rb.out}\n`
      + `    在 ${wtPath} 里解冲突 → \`git -C ${wtPath} rebase --continue\` → 重跑客观地板\n`
      + `    → \`git -C ${wtPath} commit --amend\` 把适配折回本票那笔（保持一票一 commit）→ 再 close。\n`
      + `    别用 \`git merge\`（含 -X ours）适配：内容会被静默丢弃，且机器门 ④ 会在 stage 末尾拦下整轮。`);
  }
  say(`已 rebase 到 ${target.out}。适配后记得重跑客观地板并 \`--amend\` 折回本票那笔。`);
  process.exit(0);
}

if (cmd === 'close') {
  if (!existsSync(wtPath)) die(`${wtPath} 不存在（已收口过？或 flow_id/票号写错）。`);

  const st = gitQuiet(['status', '--porcelain'], { cwd: wtPath });
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
  if (wtMerges.ok && wtMerges.out.length > 0) {
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
  const prefix = gitQuiet(['rev-parse', '--show-prefix']).out || '';
  const bookkeeping = prefix + 'docs/grill-flows/';
  const mainSt = gitQuiet(['status', '--porcelain', '-uall']);
  const stray = mainSt.ok
    ? mainSt.out.split('\n')
        .filter((l) => l.trim().length > 0)
        .filter((l) => !l.slice(3).startsWith(bookkeeping))
    : [];
  if (stray.length > 0) {
    die(`主工作树有非记账改动，拒绝回合：\n`
      + stray.map((l) => '      ' + l).join('\n')
      + `\n    stage-3 期间主树只该有 \`docs/grill-flows/\` 下的记账改动。出现代码改动，通常是子代理`
      + `用相对路径写文件、而它那次 Bash 调用的 cwd 恰好是主仓（引擎的 drifted 守卫只在 cwd≠主仓时`
      + `触发，那种情况下不拦）——于是改动落在主树、worktree 里的 commit 缺内容。`
      + `\n    怎么改：判断这些改动属于哪票 → 移进该票 worktree 并 amend 进它那笔 commit；`
      + `确属无关 stray → 停下问开发者，别一并吞进本 flow。`);
  }

  const ahead = gitQuiet(['rev-list', '--count', `HEAD..${branch}`]);
  if (ahead.ok && ahead.out === '0') {
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

  const rm = gitQuiet(['worktree', 'remove', wtPath]);
  if (!rm.ok) die('回合成功，但 `git worktree remove` 失败（分支已合，工作未丢）:\n' + rm.out);
  say(`已拆除 ${wtPath}（分支 ${branch} 保留——stage-3 的重入相位表要靠它区分「已交付未回合」；`
    + `stage-4 收尾 squash 后统一删）`);
  process.exit(0);
}

die('未知子命令: ' + cmd + '（只支持 open / sync / close）');
