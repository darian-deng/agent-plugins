# Stage 3：implement（调度页）

> grill-flow 第 3/5 步 · [流程总览](../helper.md)
> 主 session 只**调度**——算批次、开/收 worktree、回合、记账、拍板，**不写代码**。实现与评审都在子代理里跑（独立窗口，不涨主 session context）。
>
> **元规则**：本 stage 允许 commit，且**历史必须线性**（机器门断言④）。每票一笔独立代码 commit（subject 首行含 `T<n>`，一笔只认领一票）；记账改动（candidates.md、tickets.md 的 `qc:done` / `[x]`）留工作树、不单独 commit，由 stage-4 的 squash 吸收。

## 岔路 → 先读哪份

本页只留主循环和那几条「违反了不会有任何东西变红」的红线。下面每一格对应一个**可观察的触发事件**，撞上了先读那份再动手，**不要凭记忆推**。**`<FR>` = `[ai-flow:paths]` 块里的 `flow_root:`（`state/`）、`<FD>` = 同块的 `flow_def:`（`scripts/` 与岔路表点的 `references/`）**。⛔ **用 Write 写文件时换成真实路径，别把 `<FR>` / `<FD>` 原样填进 `file_path`**——sh 里代入失败会报错，Write 不会：它会在仓库根下建出一个字面名的目录，signal 落在那里等于没写，引擎不推进也不报错：

| 触发事件 | 读 |
|---|---|
| 开工第一件事：这轮用一票一树还是一组一车道 | `execution-unit.md` |
| 已选车道模式 → 动作差异、三条代价与对应处置 | `lane-mode.md` |
| 要派子代理 / 收到「完成」通知 / 怀疑子代理失联 | `subagent-lifecycle.md` |
| `/clear` 之后重入，不知道走到哪一步 | `reentry.md` |
| `/clear` 之后**背景**（目标/决策/边界）从哪读 · 走之前要写下什么 | `handoff.md` |
| 测试红 / `close` 报错 / 机器门报违规 | `recovery.md` |
| 执行中发现本期还要加一张票 | `mid-flight-ticket.md` |
| 派实施子代理（一票的第一段） | `per-ticket-review.md` |
| 实施回报了，派质量链子代理（第二段） | `quality-chain.md` |
| 想停下来问开发者（先查证，别直接问） | `ask-before-asking.md` |
| 要改前置产物（alignment / spec / tickets） | `revision-protocol.md` |

## 前置读取

- `{{project_root}}/docs/grill-flows/<flow_id>/` 下 `spec.md` + `tickets.md`（`<flow_id>` 用 context 注入的实际值，勿自拼）

## 入场

**判首次 vs 重入**：注入 context 已含 `base_sha_code` 行，或 tickets.md 已有 `[x]` → 重入，跳过 Step 1（重捕会污染 stage-4 diff 基准，引擎也拒覆写），照 `reentry.md` 走。

**Step 0 预检**（三条都要跑；违反了**入场当下没有任何脚本 / 机器门 / 退出码会报**，这里是唯一的检测方）：

- `git branch --show-current` — **在 main/master → 停**，要开发者切需求分支。为什么在这里拦：票分支从**主仓当前分支**派生、`close` 又 `--ff-only` 合回它——在 main 上开工 = 每张票从 main 开出再逐个 ff 进 main，不可逆，且没有一处会检查。
- `git status --porcelain` — 含**代码**改动 → **停**问开发者；仅 `docs/grill-flows/` 改动属正常，豁免。
- `git worktree list` — 有 `wt/<flow_id>-` 分支的条目 → 上一轮残留，照 `reentry.md` 先收口，**别新开**。**除非 tickets.md 已有 `lane:` 标记**——那是正在用的长驻车道，不是残留，按 `reentry.md` 的「车道模式的重入」接着跑。⚠️ **只有这条命令看得见它们**：落点在**仓库同级**的 `<repo 名>.ai-flow-worktrees/`、不在仓库里，`git status` 看不到。

**Step 1 起点 commit + mark-base**：`git add` 全部 flow docs（alignment.md + wayfinder-map.md + spec.md + tickets.md）→ `git commit -m "docs: <feature> stage1-2 outputs"` → 用 Write 写 `<FR>/state/mark-base`（内容任意）触发引擎捕获 `base_sha_code`。

**Step 2 定执行单位**：照 `execution-unit.md` 跑一次 `schedule.cjs` 再选，**不要凭感觉**。下面主循环写的是一票一树；车道模式的差异全在 `lane-mode.md`。

## 主循环

### 1. 算批次

**够格** = 未勾 `- [ ] T<n>` 且所有 `Blocked by` 已勾。

**可同批并行** = 够格 ∧ 与批内其它票的 `Touches` **不相交**（`Touches: none` 的票只能单独跑）。**上限 3 票**（起步值，调它见 `execution-unit.md`）。

**够格票多于 3 张时**：按 tickets.md 文件顺序贪心取写集不相交的前 3 张。**顺序不是决策，绝不用 `AskUserQuestion` 问「先做哪几张」**——这是确定性 tiebreak，也让 /clear 重入能算出同一个批次。

⚠️ **切片本身错（不是实施问题）→ 就地在 tickets.md 重切并知会开发者**。**引擎无反向 stage 转移**，别要求退回 stage-2。

只有一票够格 → 不开 worktree，就在主工作树按契约做完：**照样一票派两次**（`<WT>` 填主工作树的绝对路径）、**主 session 照样不写代码**；省掉的只是并行——无 worktree、无 rebase、回合不存在，机器门④⑤⑥⑦ 天然满足。

### 2. 落盘再派发（Clear-Safe）

派发**之前**先把批次写进 tickets.md：给本批每票加 `batch: B<k>`，**写在该票那条行内或其缩进子项**——和 `qc:done` 同一口径，**写在别处机器门⑦ 会静默跳过这票**。批次成员关系只存在于这个字段里，先派后写、/clear 就丢了。

⛔ **车道模式下这一步不一样，别以为已经做过了**：`lane:` 是分组时一次性落的**静态**字段，派发时它早就在票上了——派发前真正要落的是 `wip: R<n>`（标「这张正在飞」）。没有它，/clear 之后重入判不出在飞票，同一棵树会被派进第二个子代理。做法见 `lane-mode.md`。

### 3. 开 worktree + 派发

每票一个（车道模式：每组一个、只在该组第一票前开）：

```sh
node <FD>/scripts/worktree.cjs --flow-dir <FR> open <flow_id> T<n>
```

它负责位置、gitignore 检查、分支命名、装依赖，并打印派发要用的绝对路径——**这些都不必记，这条命令就是全部。**

**派发用它打印的哪个路径**：锚点是 monorepo 子项目时它会打印两个——`<WT>`（worktree 里的项目根，和 `Touches` 同基准）与 worktree 根。**两个都要带进 dispatch prompt**，后者按契约里的名字给成 `<WT_ROOT>`（只有改锚点外的包时用它）。只给 worktree 根会让子代理在整仓根凭空建出一层同名目录，而机器门⑥ 抓不到（剥不掉锚点前缀的路径原样比 `Touches`，全绿）。

**一票派两次，不是一次**（理由见 `quality-chain.md` 开头：最贵的那一段不能跑在最胖的那个上下文里）：

1. **实施代理**（按 `per-ticket-review.md` 拼）→ 它做完实现、改动留工作树不提交、按契约回报（首行判据在第 4 步）。
2. 回报到手后**按第 4 步那两套判据复核** → 过了在该票那条写 `impl:done`（与 `qc:done` 同一口径；机器门不解析它。**续做轮交付后照样写**——它是「剩余已做完」的唯一标记，漏了重入会再派一次实施）→ **再派质量链代理**（按 `quality-chain.md` 拼，带 `[partial]` 的走形态乙），由它走三评审 → 裁 → 地板 → commit（注释清理不在里面，见下）。

契约里的「派发时带什么」是完整清单，其中最容易漏的几条：**cwd 纪律**（git 一律 `git -C <WT>`、写一律绝对路径，漏了就静默空转）；⛔ **票面整段内联，不给 `tickets.md` 路径**（实测被整篇读过 14 次，读进去之后每轮重新计费，而别人的票一次都用不上）。`spec.md` 同理只切相关段，`gate-stage-3.cjs` 不给路径。

**派子代理的两条硬规则**（各留一句为什么；实测代价与失联处置在 `subagent-lifecycle.md`）：

- ⛔ **不为「只跑验证」派子代理**（rebase 后重跑地板、收口测试、复跑命令取数字）。子代理没有「挂起」态，丢后台就等于自杀；这类活主 session 自己跑、丢后台，它会被唤醒。
- ⛔ **不给子代理下「整仓全量」的地板要求**（更不要给全量数字目标）。它超出前台单条命令超时上限，等于逼它自杀。子代理的地板是「typecheck + 本票测试 + 本票直接影响到的包/目录」，整仓全量在第 6 步由你跑。

**接缝声明**：三评审与 `/simplify` 由**质量链代理自己顺序做完**——⛔ **派发 prompt 里给它写死：不许再往下派孙代理。** 那一层结构性异步、没有开关能关，而子代理不能被唤醒，派完只剩空烧着等（实测代价与 9 次事故见 `quality-chain.md` 文末）。**你自己派子代理反而可以丢后台**（主 session 会被唤醒）。**`comment` 注释清理归你**，落在第 5 步。

**批内并行派发**：本批各票的实施子代理同时派。

⚠️ **派完不要只等通知。通知是一次性的**——它已经来过、而你读错了，就不会有第二条来纠正你（实测空转 1 小时 07 分正是这个机制）。**每隔 15 分钟主动扫一次**，一屏看全各票/各车道的 `ahead / dirty / HEAD 后继 / 待补依赖 / 静默时长`：

```sh
node <FD>/scripts/worktree.cjs --flow-dir <FR> status <flow_id>
```

**一棵声称在飞的树静默 ≥30 分钟 = 那个子代理已经停了**（工作树的物理变化是唯一不依赖自我报告的信号）→ `subagent-lifecycle.md`。

### 4. 裁子代理回报（回合之前）

**收到「完成」通知，先做一次机械判定再读正文**——判据按你派的是哪一段分两套：

- **实施代理**：首行必须是 `impl-done: <N> 个文件已改，未提交` → 复核 `git -C <WT> status --porcelain` **非空**、且 `git -C <WT> log --oneline -1` **不该有本票的新 commit**。⚠️ 截断自保护时首行是 `commit: <sha> [partial]`：树干净、不适用非空复核，改核那笔在不在，**把回报里的剩余清单落成票面 `rest: <差什么/做到哪>` 字段**（与 `wip:` 同口径。⛔ **只留在你上下文里等于没落**——`/clear` 之后就没了，而续派和质量链的 fail-closed 都以它为键），**再按它续派实施代理**（⛔ 别直接派质量链让它捎带做剩余）。
- **质量链代理**：首行必须是 `commit: <sha>` → 复核树**为空**、`HEAD` 等于那个 sha。

首行不是这两者之一，或那两条复核命令有一条对不上 → **这一票没交付、那个子代理还没停**，不管状态写的是不是 `completed`。⚠️ 已有 `[partial]` 的票又回报未完成（续做轮再撞上限）→ **先用新回报刷新票面 `rest:`**，否则续派会拿陈旧清单重做已完成的部分。

⚠️ **别把两套用混**：实施代理交付后树本来就是脏的，拿「必须为空」去核它会永远判成「它还没停」，质量链就永远派不出去。

⛔ **没全对上就绝不要动那棵树**（提交 / rebase / 另派人进去）。三个评审读的是**未提交**的改动，你此刻提交会让它们对着空 diff 各写一份「没发现问题」，而这不报任何错误。失联处置、已经踩了怎么补在 `subagent-lifecycle.md`。

质量链代理只处置机械型 findings，判断型的连同证据回报上来（`quality-chain.md` 第 2 步）。**必须在回合之前裁**——一旦 `--ff-only` 合进需求分支，安全红线就是「已合入才停下问」，而且那时该票 worktree 已拆、没法在它里面改：

- 质量 / smell / spec-drift / bug → 派质量链代理**在该票 worktree 里**改，重跑客观地板，⛔ **改完 `git -C <WT> commit --amend` 折回本票那笔**（另提一笔会破「一票一 commit」，机器门③ 的配对只认领其中一笔、另一笔的改动逃过⑥ 的 `Touches` 核对而全绿）
- **人在环落点（本 stage 唯一）**：命中安全红线（定义见 `per-ticket-review.md`）或需开发者拍板的取舍 → 停下 `AskUserQuestion`
- 需真机 / 鉴权 / 运行时验证 → **不是停点**，记下来，第 6 步打 `rm:pending`，留 stage-4 环节 C 集中做

### 5. 注释清理 → 逐票回合（串行）

裁完、无未决项之后，**先清注释、`--amend` 前必跑那节三条核实命令（测试文件零改动漏过一次）、票面写 `cm:done`，再 close**（做法与理由见 `quality-chain.md` 第 3 步）：⛔ 顺序反了就补不回来——ff 之后 `--amend` 不可用。

```sh
node <FD>/scripts/worktree.cjs --flow-dir <FR> close <flow_id> T<n>
```

它跑一组前置断言 → `git merge --ff-only` → 拆除 worktree、保留分支，并报出「哪些兄弟车道现在过期了」。断言失败时脚本会说清是哪一条、怎么处置——**先照它说的做**，别绕过；脚本没覆盖到的失败形态在 `recovery.md`。

⛔ **`close` 必须单独成一条命令。** 不要写成 `<跑测试> && node …close …`——`&&` 只看退出码，而假红（依赖陈旧）和假绿（选择器打空）下退出码并不代表结论。你要**先看到**验证输出、自己下判断，再单独发一条 close。ff 不可逆：票进了需求分支再退回要 reset 主分支，而那时 worktree 可能已拆。实测发生过一次：验证与 close 串成一条链，一张地板红的票就这么合进了需求分支。

### 6. 记账（按票）与收口测试（按批）

**记账的触发点是「该票 `close` 成功」，不是「本批结束」**——一票 ff 进需求分支之后**立刻**做。理由：子代理的回报只活在你的上下文里，而 `/clear` 随时会发生——commit 是持久的，「它想告诉你什么」不是（实测代价见 `lane-mode.md`）。

逐票记账（留工作树、不单独 commit），**顺序照这个来**：

1. 落 candidates.md（带 ticket ID 前缀、append 前 grep 去重）
2. 需真机的票加 `rm:pending`，并往 tickets.md `## 待真机验证` 段 append 一条 `- T<n> — <一句话验什么>`
3. **把质量链回报第二行的 `qc-metrics: …` 原样抄到该票那条**（与 `qc:done` 同一口径）。⛔ 别自己重算、别改格式——它是「小票该不该减配质量链」的唯一样本来源，而 commit body 留不住它（stage-4 的 squash 会连票分支一起删）
4. 在该票那条上写 `qc:done`（行内或其缩进子项，写在别处不算）
5. 勾 `[x]`

⛔ **`rm:pending` 必须排在 `qc:done` 之前**：重入相位表用 `qc:done` 当「记账已完成」的锚，如果 `rm:pending` 在它之后写，恰好在两者之间 /clear 就会被「有 `qc:done` 无 `[x]` → 补勾」这条路径**永久跳过**真机登记，而这个丢失是静默的（stage-4 的收口只认该段登记过的票）。

⛔ **车道模式下这份清单还要多一步「已知碰撞面登记」，且它和 `rm:pending` 一样必须排在 `qc:done` 之前**；收口测试也不按批、按轮且有硬上限——两条都在 `lane-mode.md`，**漏做不会有任何东西变红**。

**收口测试**：本批全部回合完后，**一次**跑该批相关测试 + typecheck（**整仓全量回归的唯一落点就是这里**）。理由：批内前几次回合的结果都会被最后一次覆盖，逐票各跑一遍是重复劳动，而全部归并后的这棵树还没人验过。**你自己跑，需要多久就跑多久，丢后台也没关系**——后台命令完成会把你唤醒。测试红了先读 `recovery.md` 判是不是假红；真要修也在那里（worktree 已拆，得走 `--fixup` + `--autosquash`）。

**推进下一批前自检**：本批每票都有自己那笔 commit + `qc:done` + `[x]`、本 flow 的 worktree 已全部拆除、无未裁决的决策/安全项。（**车道模式下这条自检不一样**，别照抄——见 `lane-mode.md`。）

### 连续执行

批与批之间、票与票之间**都不做「要不要继续」式 check-in**——过了上面那道自检就直接算下一批。唯一的停点是第 4 步的安全/拍板 fork。（落盘、记账、开收 worktree 是必做调度动作，不算 check-in。）

## 输出规格

每票一笔代码 commit + `tickets.md` 与 `candidates.md` 的记账——规格见上「元规则」与主循环第 3/6 步。验证是机器门 `scripts/gate-stage-3.cjs`（fail-closed）——**七条断言的规格、理由、每条报错怎么改都在脚本里，取那份**；违规处置见 `recovery.md`。

## 完成条件

机器门 fail-closed 拦得住的（全部 `[x]` 且各有 `qc:done`、worktree 全拆除、历史线性）不必自查。**唯一需要你自己保证的**：

- **本 stage 期间问开发者拍板的结论已逐条落盘**：新增决策写进 `spec.md` 的 `## Decisions`；改动了范围 / 已对齐结论的走 `revision-protocol.md` 回写 `alignment.md`。机器门验不了这条，但它决定下一次 /clear 之后这些结论还在不在——不落盘就等于没问过。

## Signal

**触发条件**：全部 `[x]`，**或**开发者明确表示完成。
**动作**：用 Write 工具向 `<FR>/state/signal` 写入 `done`。引擎跑机器门（`gate-stage-3.cjs`，fail-closed）通过后**自动进 stage-4**（本 stage 无人工 gate——这道门是唯一的引擎兜底）。
