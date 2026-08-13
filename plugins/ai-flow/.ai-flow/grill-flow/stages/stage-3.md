# Stage 3：implement（调度页）

> grill-flow 第 3/5 步 · [流程总览](../helper.md)
> 当前 stage 目的：主 session 作**调度器**——算批次、开/收 worktree、回合、记账、拍板。一票内部怎么做完，全在 `per-ticket-review.md`（子代理的交付契约），本页不复述。
>
> **元规则**：本 stage 允许 commit，且**历史必须线性**（机器门断言④）。每票一笔独立代码 commit（subject 首行含 `T<n>`，一笔只认领一票）作执行期锚点；记账改动（candidates.md、tickets.md 的 `qc:done` / `[x]`）留工作树、不单独 commit，由 stage-4 环节 C `git reset` 摊平后 squash 吸收。

## 先查文档，再问开发者

到了本 stage，前面两步已经把决策落成了文件。**执行越往后，「这个当时定过吗」的答案越是「定过」**——而你手上没有那段对话，只有文件。所以：**任何「要不要停下来问开发者」的念头，先当成一次查证任务**。

| 疑问 | 查这里 |
|---|---|
| 做到什么程度算完 / 这个要不要做 / 是不是推迟了 | `alignment.md` 的 `## 需求`、`## 不在范围内`、`## 暂缓` |
| 为什么是 A 不是 B / 某方案是不是已经否掉了 | `alignment.md` 的 `## 关键决策`；`spec.md` 的 `## Decisions`、`## 方案审查` |
| 这个词在本项目里指什么 | `alignment.md` 的 `## 术语表` |
| 测什么、在哪一层测 | `spec.md` 的 `## Testing Decisions` |
| 预期行为是什么 | `spec.md` 的 `## User Stories`；该票的 `AC:` |
| 跨端 / 跨仓怎么约定的 | `spec.md` 的 `## 跨端/跨仓行为契约` |
| 谁先做 / 能不能一起做 / 该票该碰哪些文件 | `tickets.md` 的 `Blocked by`、`Touches` |

- **查到了 → 照做，不问。** 把已定的事再问一遍，等于让开发者重做一次已经做过的功课。
- **查不到 → 才问**；拿到答案**立即写回上表对应的那个文件**。`AskUserQuestion` 的结论不落盘，下一次 /clear 之后就会被重新问一遍。
- **查到的结论与你此刻的判断冲突 → 不自行推翻**，走 `revision-protocol.md`（它对「与已记录决策冲突」「推翻前置结论」有分级处理，L1/L2 必须停下）。

同一条纪律对子代理同样成立，它那侧的版本在 `per-ticket-review.md`。

## 目标

主 session 只调度，不写代码。实现与评审都在子代理里跑（各有独立窗口、不涨主 session context）。可并行的票各开一个 worktree 同时做，主 session 在依赖满足时逐个回合。

## 前置读取

- `{{project_root}}/docs/grill-flows/<flow_id>/` 下 `spec.md` + `tickets.md`（`<flow_id>` 用 context 注入的实际值，勿自拼）
- `{{flow_root}}/references/per-ticket-review.md` — **一票的交付契约（派发子代理时按它拼 prompt；本页不复述其内容）**
- `{{flow_root}}/references/revision-protocol.md`

## 入场

**判首次 vs 重入**：注入 context 已含 `base_sha_code` 行，或 tickets.md 已有 `[x]` → 重入，跳过 Step 1（重捕会污染 stage-4 diff 基准，引擎也拒覆写），照下方「重入」走。

**Step 0 预检**：`git branch --show-current`（在 main/master → 停，要开发者切需求分支）；`git status --porcelain`（含**代码**改动 → 停问开发者；仅 `docs/grill-flows/` 改动属正常，豁免）；`git worktree list`（有 `.worktrees/` 下条目 → 这是上一轮残留，照「重入」先收口，别新开）。

**Step 1 起点 commit + mark-base**：`git add` 全部 flow docs（alignment.md + wayfinder-map.md + spec.md + tickets.md）→ `git commit -m "docs: <feature> stage1-2 outputs"` → 用 Write 写 `{{flow_root}}/state/mark-base`（内容任意如 `capture`）触发引擎捕获 `base_sha_code`。

## 主循环

### 1. 算批次

**够格** = 未勾 `- [ ] T<n>` 且所有 `Blocked by` 已勾。

**可同批并行** = 够格 ∧ 与批内其它票的 `Touches` **不相交**（`Touches: none` 的票只能单独跑）。**上限 3 票**——再往上，串行回合段与主 session context 的增长会吃掉并行收益（这是起步值，见下方「并行度」）。

**够格票多于 3 张时**：按 tickets.md 文件顺序贪心取写集不相交的前 3 张。**顺序不是决策，绝不用 `AskUserQuestion` 问「先做哪几张」**——这是确定性 tiebreak（打破平局的默认规则），也让 /clear 重入能算出同一个批次。

只有一票够格 → 不开 worktree，就在主工作树按契约做完（串行路径不受本 stage 任何并行机制影响：无 worktree、无 rebase、回合不存在，机器门④⑤⑥⑦ 天然满足）。

### 2. 落盘再派发（Clear-Safe）

派发**之前**先把批次写进 tickets.md：给本批每票加 `batch: B<k>` 标记，**写在该票那条行内或其缩进子项**（和 `qc:done` 同一口径——写在别处，机器门⑦ 会静默跳过这票）。批次成员关系只存在于这个字段里，先派后写、/clear 就丢了。

### 3. 开 worktree + 派发

每票一个：

```sh
node {{flow_root}}/scripts/worktree.cjs open <flow_id> T<n>
```

它负责位置、gitignore 检查、分支命名、装依赖，并打印派发要用的绝对路径。**位置/命名/装依赖不必记，这条命令就是全部。**

按 `per-ticket-review.md` 拼 dispatch prompt。契约里的「派发时带什么」是完整清单，其中**最容易漏、漏了就静默空转**的是那条 cwd 纪律（一切 git 用 `git -C <WT>`、一切写用 `<WT>/…` 绝对路径）——务必原样带上。

**接缝声明（免得两边都以为是对方的事）**：三评审、`/simplify`、`comment` skill 全在**子代理内部**自己派/自己调，**主 session 不另派**；子代理只把判断型/决策型/安全型 findings 回报上来，由你裁。

**批内并行派发**：本批各票的实施子代理同时派。

### 4. 裁子代理回报（回合之前）

子代理只处置机械型 findings，判断型的连同证据回报上来（契约步骤 3）。**必须在回合之前裁**——一旦 `--ff-only` 合进需求分支，安全红线就是"已合入才停下问"，而且那时该票 worktree 已拆、没法在它里面改：

- 质量 / smell / spec-drift / bug → 派子代理**在该票 worktree 里**改，重跑客观地板
- **人在环落点（本 stage 唯一）**：命中安全红线（定义见 `per-ticket-review.md`）或需开发者拍板的取舍 → 停下 `AskUserQuestion`
- 需真机 / 鉴权 / 运行时验证 → **不是停点**，记下来，第 6 步打 `rm:pending`，留 stage-4 环节 C 集中做

### 5. 逐票回合（串行）

裁完、无未决项之后：

```sh
node {{flow_root}}/scripts/worktree.cjs close <flow_id> T<n>
```

它跑四条前置断言（worktree 干净、票分支上无 merge commit、主树无非记账改动、票分支确有 commit）→ `git merge --ff-only` → 拆除 worktree、保留分支。断言失败时它会说清是哪一条、怎么处置——照它说的做，别绕过。

**`close` 报"不是直接后继"** = 别的票已经先回合了、本票还没适配 → 派一个新的子代理（原来那个已经返回）带本票上下文去 `worktree.cjs sync <flow_id> T<n>` → 解冲突 → 重跑客观地板 → `git -C <WT> commit --amend` 折回本票那笔 → 再 close。**不要在主树上解冲突**：那会产生 merge commit（机器门④ 拦），而且主树没有该票的实施上下文。

**回合必须逐票串行。** 一票 close 失败退回适配时，本批其余未回合的票不必跟着重新适配——它们各自 close 时若失败，同样按上面这条走。

### 6. 批次收口

本批全部回合完后，**一次**跑该批相关测试 + typecheck。理由是「批次全部归并后这棵树没有人验过」——批内前几次回合的结果都会被最后一次覆盖，逐票各跑一遍是重复劳动。

**收口测试失败怎么办**：worktree 已拆，`--amend` 折回中间那笔票 commit 做不到。就在主树修，另提**一笔 subject 不含任何票号的 `fix:` commit**——票↔commit 是一一配对的，带票号会造成争用；不带票号则不占用配对。但机器门要求区间内每笔 commit 都归属某一票，所以这笔要**紧接着 `git rebase -i` squash 进它真正属于的那张票**那笔里（或用 `--fixup` + `--autosquash`）。同时在回报/review 交接里记下它属于哪票。

然后逐票记账（留工作树、不单独 commit），**顺序照这个来**：落 candidates.md（带 ticket ID 前缀、append 前 grep 去重）→ 需真机的票加 `rm:pending` 并往 tickets.md `## 待真机验证` 段 append 一条 `- T<n> — <一句话验什么>` → 在该票那条上写 `qc:done`（行内或其缩进子项，写在别处不算）→ 勾 `[x]`。

`rm:pending` **排在 `qc:done` 之前**是有原因的：重入相位表用 `qc:done` 当"记账已完成"的锚，如果 `rm:pending` 在它之后写，恰好在两者之间 /clear 就会被"有 `qc:done` 无 `[x]` → 补勾"这条路径永久跳过真机登记。

**推进下一批前**：本批每票都有自己那笔 commit + `qc:done` + `[x]`、`.worktrees/` 已空、无未裁决的决策/安全项。

### 连续执行

批与批之间、票与票之间**都不做「要不要继续」式 check-in**——过了上面那道自检就直接算下一批。唯一的停点是第 5 步的安全/拍板 fork。（落盘、记账、开收 worktree 是必做调度动作，不算 check-in。）

### 并行度

`3` 是起步值，不是测出来的最优。首轮跑完记一笔：省下的（N 份实施+三评审的墙上时间）vs 付出的（回合失败时的 rebase 适配 + 批次收口测试 + N 份装依赖），再调。

算成本时别漏了**实际峰值并发**：每票 = 1 实施 + 3 评审 + `comment` skill 自己的 fan-out（每文件一个 `sonnet`、最多 10 并行）。3 票同时走到注释清理那步，峰值可达数十个 agent。真正的上限往往是这个，不是票数。

## 重入

引擎只恢复到「stage-3」，不记进度。**第一步必须枚举，不能直接看 tickets.md 就重派**：

```sh
git worktree prune && git worktree list --porcelain
```

`.worktrees/` 下有条目 → 先收口存量，**不得重派**（重派会撞 `fatal: a branch named 'wt/<flow_id>-T<n>' already exists`，并留下孤儿 worktree）。

逐票判相位——**锚 = 该票那笔 commit（在主分支或在它自己的分支上）+ `qc:done`**：

| 该票 commit 在哪 | worktree | 相位 | 动作 |
|---|---|---|---|
| 不存在 | 无 | 未派 | 正常派发 |
| 不存在（分支零 commit） | 有，且干净 | 已开未派 | **别 close**（对零 commit 分支 ff 会 "Already up to date" 并成功拆除，看起来像交付了、实则一行代码没有——`close` 现在会拦）。直接派发子代理 |
| 不存在 | 有，里面有未提交改动 | 在飞（质量链中途） | 先定夺工作树（reset 重来 or 在现状上续，把决定写进重派 prompt），续跑契约 |
| 有 `[partial]` 标记 + 剩余清单 | 有 | 截断续做 | 按清单续派（**不做 git 考古**）→ 末轮 `--amend` 去掉 `[partial]` → 走完契约剩余步骤 |
| 在 `wt/<flow_id>-T<n>` 上、未合回来 | 有 | 已交付未回合 | **别重派**——先裁回报（第 4 步）再走回合（第 5 步） |
| 在 `wt/<flow_id>-T<n>` 上、未合回来 | 无（分支还在） | 已交付、工作目录被清掉 | 上面那步 `git worktree prune` 本身就会制造这个状态（有人手动删过目录）。`git worktree add <path> <branch>` 复用该分支恢复，再按上一行走。**别重派**——重派会撞「分支已存在」 |
| 在主分支上 | 还在（`close` 里 ff 成功但 remove 失败） | 已回合未拆 | `git worktree remove` 补拆，再按下一行继续 |
| 在主分支上、无 `qc:done` | 无 | 已回合未记账 | 补第 6 步的记账（**含 `rm:pending` 判定**），不重跑质量链 |
| 在主分支上、有 `qc:done` 无 `[x]` | 无 | 记账收尾 | 补勾 |
| 在主分支上、`qc:done` + `[x]` | 无 | 完成 | 进下一票 |

**查该票 commit**：`git log --oneline --no-merges <base>..HEAD`（在主分支）与 `git log --oneline <base>..wt/<flow_id>-T<n>`（在票分支）。只看 subject 首行，别翻 body——body 里有对未来票号的前向引用。

- 切片本身错（不是实施问题）→ 就地在 tickets.md 重切并知会开发者（引擎无反向 stage 转移）。
- 前置产物要改 → 走 `revision-protocol.md`。

## 输出规格

git commits（每票一笔代码 commit、subject 首行含 `T<n>`、**历史线性**）+ `tickets.md`（`batch:` / `qc:done` / `[x]`，真机票另带 `rm:pending` + `## 待真机验证` 段）+ `candidates.md`——后两者为工作树未提交状态，由 stage-4 squash 吸收。

验证：机器门 `scripts/gate-stage-3.cjs`（fail-closed）。**七条断言的规格、各自的理由、以及每条报错的「怎么改」都在脚本里（头部注释 + 各条报错文案），取那份**——本页的「完成条件」与主循环各步已经涵盖你要做的动作，在此复述规格只会漂。

只有一件脚本不会告诉你：**「实际改动超出 `Touches`」和「同一 batch 内两票改了相同文件」这两条被 rebase 适配触发，是预期情形、不是你做错了流程**。一票适配时若不得不改另一票的文件（往对方新建的注册表里加一条这类），门必然报。

这时的处置是**把实际耦合登记下来**，而不是把证据删掉：给后归并那票补上 `Blocked by: <前一票>`、把它移出本批（改成单独一批），并在 review 交接里记一句「这两票实际有耦合，下轮切片时切进同一票」。**不要为了过门而抹掉 `batch:` 标记**——`batch:` 是「同批写集不相交」这条检查唯一的触发条件，删掉它等于把检查关掉，而那条检查正是并行安全的全部依据。

## 完成条件

- tickets.md 全部 ticket 级项 `[x]`，每个都有 `qc:done`。
- `.worktrees/` 已空，历史线性。
- **本 stage 期间问开发者拍板的结论已逐条落盘**：新增决策写进 `spec.md` 的 `## Decisions`；改动了范围 / 已对齐结论的走 `revision-protocol.md` 回写 `alignment.md`。机器门验不了这条，但它决定下一次 /clear 之后这些结论还在不在——不落盘就等于没问过。

## Signal

**触发条件**：全部 `[x]`，**或**开发者明确表示完成。
**动作**：用 Write 工具向 `{{flow_root}}/state/signal` 写入 `done`。引擎跑机器门（`gate-stage-3.cjs`，fail-closed）通过后**自动进 stage-4**（本 stage 无人工 gate——这道门是唯一的引擎兜底）。
