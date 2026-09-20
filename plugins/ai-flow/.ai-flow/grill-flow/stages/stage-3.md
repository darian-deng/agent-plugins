# Stage 3：implement（调度页）

> grill-flow 第 3/5 步 · [流程总览](../helper.md)
> 主 session 只**调度**——算批次、开/收 worktree、回合、记账、拍板，**不写代码**。实现与评审都在子代理里跑，不涨主 session context。
>
> **元规则**：本 stage 允许 commit，**历史必须线性**（机器门断言④）。每票一笔独立代码 commit（subject 首行含 `T<n>`，一笔只认领一票）；记账改动留工作树、不单独 commit，由 stage-4 squash 吸收。

## 岔路 → 先读哪份

本页只留主循环和那几条「违反了不会变红」的红线。每格是一个**可观察的触发事件**，撞上了先读那份再动手，**别凭记忆推**。**`<FR>` = `[ai-flow:paths]` 块里的 `flow_root:`（`state/`）、`<FD>` = 同块的 `flow_def:`（`scripts/` 与 `references/`）**。⛔ **用 Write 写文件时换成真实路径，别把 `<FR>` / `<FD>` 原样填进 `file_path`**——sh 里代入失败会报错，Write 不会：它在仓库根建出字面名目录，signal 落那儿等于没写，引擎不推进也不报错：

| 触发事件 | 读 |
|---|---|
| 开工第一件事：一票一树还是一组一车道 | `execution-unit.md` |
| 已选车道模式 → 动作差异与三条代价 | `lane-mode.md` |
| 要派子代理 / 收到「完成」通知 / 怀疑失联 | `subagent-lifecycle.md` |
| `/clear` 后重入，不知走到哪一步 | `reentry.md` |
| `/clear` 后**背景**（目标/决策/边界）从哪读 · 走前写什么 | `handoff.md` |
| 测试红 / `close` 报错 / 机器门报违规 | `recovery.md` |
| 执行中还要加一张票 | `mid-flight-ticket.md` |
| 派实施代理（第一段） | `per-ticket-review.md` |
| 实施回报了，派质量链代理（第二段） | `quality-chain.md` |
| 想停下来问开发者（⛔ 不许直接问，三步在第 4 步） | `ask-before-asking.md` |
| 要改前置产物（alignment / spec / tickets）· **开发者纠正了一条事实** | `revision-protocol.md` |

## 前置读取

- `{{project_root}}/docs/grill-flows/<flow_id>/` 下 `spec.md` + `tickets.md`（`<flow_id>` 用 context 注入的实际值，勿自拼）

## 入场

**判首次 vs 重入**：注入 context 已含 `base_sha_code` 行，或 tickets.md 已有 `[x]` → 重入，跳过 Step 1（重捕污染 stage-4 diff 基准，引擎也拒覆写），照 `reentry.md` 走。

**Step 0 预检**（三条都要跑；违反了**入场当下没有任何脚本/机器门/退出码会报**）：

- `git branch --show-current` — **在 main/master → 停**，要开发者切需求分支。票分支从**主仓当前分支**派生、`close` 又 `--ff-only` 合回它——在 main 上开工就是逐票 ff 进 main，不可逆且无一处检查。
- `git status --porcelain` — 含**代码**改动 → **停**问开发者；仅 `docs/grill-flows/` 改动豁免。
- `git worktree list` — 有 `wt/<flow_id>-` 分支的条目 → 上一轮残留，照 `reentry.md` 先收口，**别新开**。**除非 tickets.md 已有 `lane:` 标记**——那是在用的长驻车道，不是残留，按「车道模式的重入」接着跑。⚠️ 落点在**仓库同级**的 `<repo 名>.ai-flow-worktrees/`，**只有这条命令看得见**，`git status` 看不到。

**Step 1 起点 commit + mark-base**：`git add` 全部 flow docs（alignment.md + wayfinder-map.md + spec.md + tickets.md）→ `git commit -m "docs: <feature> stage1-2 outputs"` → 用 Write 写 `<FR>/state/mark-base`（内容任意）触发引擎捕获 `base_sha_code`。

**Step 2 定执行单位**：照 `execution-unit.md` 跑一次 `schedule.cjs` 再选，**别凭感觉**。主循环写的是一票一树；车道模式的差异全在 `lane-mode.md`。

## 主循环

### 1. 算批次

**够格** = 未勾 `- [ ] T<n>` 且所有 `Blocked by` 已勾。

**可同批并行** = 够格 ∧ 与批内其它票的 `Touches` **不相交**（`Touches: none` 的票只能单独跑）。**上限 3 票**（起步值，见 `execution-unit.md`）。

**够格票多于 3 张时**：按 tickets.md 文件顺序贪心取写集不相交的前 3 张。**顺序不是决策，绝不用 `AskUserQuestion` 问「先做哪几张」**——确定性 tiebreak，/clear 重入才算得出同一批。

⚠️ **切片本身错（不是实施问题）→ 就地在 tickets.md 重切并知会开发者**。**引擎无反向 stage 转移**，别要求退回 stage-2。

只有一票够格 → 不开 worktree，在主工作树按契约做完：**照样一票派两次**（`<WT>` = 主工作树绝对路径）、**照样不写代码**；省掉的只是并行：无 worktree/rebase/回合，机器门④⑤⑥⑦ 天然满足。

### 2. 落盘再派发（Clear-Safe）

派发**之前**先把批次写进 tickets.md：给本批每票加 `batch: B<k>`，**写在该票那条行内或其缩进子项**——和 `qc:done` 同一口径，**写在别处机器门⑦ 会静默跳过这票**。批次成员关系只存在这个字段，先派后写、/clear 就丢。

⛔ **车道模式下这一步不一样，别以为做过了**：`lane:` 是分组时一次性落的**静态**字段，派发时早在票上——派发前真正要落的是 `wip: R<n>`（标「这张正在飞」）。没有它，/clear 后判不出在飞票，同一棵树会被派进第二个子代理。见 `lane-mode.md`。

### 3. 开 worktree + 派发

每票一个（车道模式：每组一个、只在该组第一票前开）：

```sh
node <FD>/scripts/worktree.cjs --flow-dir <FR> open <flow_id> T<n>
```

它负责位置、gitignore 检查、分支命名、装依赖，打印派发用的绝对路径——**不必记，这条命令就是全部。**

**用打印的哪个路径**：锚点是 monorepo 子项目时打印两个——`<WT>`（项目根，和 `Touches` 同基准）与 worktree 根（`<WT_ROOT>`）。**两个都要带进 dispatch prompt**：只给后者，子代理会在整仓根凭空建一层同名目录，机器门⑥ 抓不到。

**一票派两次，不是一次**（理由见 `quality-chain.md` 开头：最贵的那段不能跑在最胖的上下文里）：

1. **实施代理**（按 `per-ticket-review.md` 拼）→ 做完实现、改动留工作树不提交、按契约回报。
2. 回报到手后**按第 4 步那两套判据复核** → 过了在该票那条写 `impl:done`（与 `qc:done` 同一口径，机器门不解析。**续做轮交付后照样写**——它是「剩余已做完」的唯一标记，漏了重入会再派一次实施）→ **再派质量链代理**（按 `quality-chain.md` 拼，`[partial]` 走形态乙），由它走三评审 → 裁 → 地板 → commit。

契约里的「派发时带什么」是完整清单（含 cwd 纪律），这里只补一条：⛔ **票面整段内联，不给 `tickets.md` 路径**（实测被整篇读过 14 次、每轮重新计费，别人的票一次都用不上）。`spec.md` 同理只切相关段，`gate-stage-3.cjs` 不给路径。

**派子代理的两条硬规则**（理由与失联处置在 `subagent-lifecycle.md`）：

- ⛔ **不为「只跑验证」派子代理**（rebase 后重跑地板、收口测试、取数字）——子代理丢后台就是自杀；这类活你自己跑、丢后台会被唤醒。
- ⛔ **不给子代理下「整仓全量」的地板要求**（更别给全量数字目标）。它的地板是「typecheck + 本票测试 + 直接影响的包/目录」，整仓全量第 6 步由你跑。

**接缝声明**：三评审由**质量链代理自己顺序做完**（⛔ `/simplify` 已整步删除，见 `quality-chain.md` 第 0 步）——⛔ **派发 prompt 里写死：不许再往下派孙代理。** 那一层结构性异步、关不掉，派完只能空烧着等（代价与 9 次事故见该文文末）。**你自己派子代理反而可以丢后台**。**`comment` 注释清理归你**，第 5 步。

**批内并行派发**：本批各票的实施子代理同时派。

⚠️ **派完不要只等通知。通知是一次性的**——读错了就没有第二条纠正（实测空转 1 小时 07 分）。**每隔 15 分钟主动扫一次**——定时用 `Bash` + `run_in_background: true` 跑 `sleep 900`（见 `subagent-lifecycle.md`；⛔ 前台 `sleep` 被宿主拦），一屏看全各票/各车道的 `ahead / dirty / HEAD 后继 / 待补依赖 / 静默时长`：

```sh
node <FD>/scripts/worktree.cjs --flow-dir <FR> status <flow_id>
```

⛔ **「有东西在跑」要么带 `bash_id`、要么不许说**（管的是这句话，**不是结束回合本身**）：同一条消息里给出那个 `run_in_background` 调用的 `bash_id`，否则明说什么都没在跑。实测最严重一次：声称「收口测试跑着」而根本没启动，静默 **335 分钟**。

**一棵声称在飞的树静默 ≥30 分钟 = 那个子代理已经停了** → `subagent-lifecycle.md`。

### 4. 裁子代理回报（回合之前）

**收到「完成」通知，先做机械判定再读正文**——判据按派的哪一段分两套：

- **实施代理**：首行必须是 `impl-done: <N> 个文件已改，未提交；AC 已交 <编号列表|全部> / 未交 <编号列表|无>` → 复核 `git -C <WT> status --porcelain` **非空**、`git -C <WT> log --oneline -1` **不该有本票的新 commit**。⚠️ 截断自保护时首行是 `commit: <sha> [partial]`：树干净，改核那笔在不在，**把剩余清单落成票面 `rest: <差什么/做到哪>`**（与 `wip:` 同口径；⛔ 只留在上下文里等于没落——续派和质量链的 fail-closed 以它为键），**再按它续派实施代理**（⛔ 别直接派质量链捎带做剩余）。⚠️ **`未交` 不是「无」⇒ 那几条 AC 同样落成 `rest:`、走上面那条续派路径**，⛔ 别另开一条（实测：9 条 AC 的票只交 3 条、机械判据全绿）。
- **质量链代理**：首行必须是 `commit: <sha>` → 复核树**为空**、`HEAD` 等于那个 sha。

首行不是这两者之一，或复核有一条对不上 → **这一票没交付、那个子代理还没停**，不管状态是不是 `completed`。⚠️ **别把两套用混**：拿「必须为空」去核实施代理会永远判成「它还没停」，质量链永远派不出去。⚠️ 已有 `[partial]` 的票又回报未完成（续做轮再撞上限）→ **先用新回报刷新票面 `rest:`**，否则续派会拿陈旧清单重做已完成的部分。

⛔ **没全对上就绝不动那棵树**（提交 / rebase / 另派人）——此刻提交，三评审会对着空 diff 各写「没发现问题」且不报错。失联处置与补救见 `subagent-lifecycle.md`。

机械型 findings 由质量链代理处置，判断型的连证据报上来（`quality-chain.md` 第 2 步）。**必须在回合之前裁**——一旦 `--ff-only` 合进需求分支，安全红线就成了「已合入才停下问」，而 worktree 已拆、改不了：

- 质量 / smell / spec-drift / bug → 派质量链代理**在该票 worktree 里**改，重跑客观地板，⛔ **改完 `git -C <WT> commit --amend` 折回本票那笔**（另提一笔破「一票一 commit」，机器门③⑥ 都抓不到）
- **人在环落点（本 stage 唯一）**：命中安全红线（见 `per-ticket-review.md`）或需拍板的取舍 → ⛔ 不许直接问，三步（`ask-before-asking.md`）：① 查它那张「疑问 → 查哪节」表，查到照做**不问**；② 查不到仍不问，先出带依据的推荐、派 fresh-context 子代理专攻（⛔ 不许造反驳，「攻不动」要带攻法与取证；无取证的 finding 不合并，平局保留原方案）；③ 攻不下才 `AskUserQuestion`，写清攻不下在哪。⚠️ 判据是「这事必须开发者决策吗」，不是「你多不确定」——属于那几类的别先审一轮再问
- 需真机 / 鉴权 / 运行时验证 → **不是停点**，记下来，第 6 步打 `rm:pending`，留 stage-4 环节 C 做

### 5. 注释清理 → 逐票回合（串行）

裁完、无未决项后，**先清注释、`--amend` 前必跑那节三条核实命令、票面写 `cm:done`，再 close**（见 `quality-chain.md` 第 3 步）：⛔ 顺序反了补不回来——ff 后 `--amend` 不可用。

```sh
node <FD>/scripts/worktree.cjs --flow-dir <FR> close <flow_id> T<n>
```

它跑一组前置断言 → `git merge --ff-only` → 拆 worktree、保留分支，并报出「哪些兄弟车道过期了」。断言失败时它会说清哪一条、怎么处置，**先照它说的做**；没覆盖的失败形态在 `recovery.md`。

⛔ **`close` 必须单独成一条命令。** 别写成 `<跑测试> && node …close …`——`&&` 只看退出码，而假红（依赖陈旧）/假绿（选择器打空）下退出码不代表结论。你要**先看到**验证输出、自己判断，再单独发 close。ff 不可逆（退回要 reset 主分支）。实测发生过一次：串成一条链，一张地板红的票就这么合进需求分支。

### 6. 记账（按票）与收口测试（按批）

**记账的触发点是「该票 `close` 成功」，不是「本批结束」**——一票 ff 进需求分支后**立刻**做。理由：子代理的回报只活在你上下文里，`/clear` 随时会发生（代价见 `lane-mode.md`）。

逐票记账（留工作树、不单独 commit），**顺序照这个来**：

1. 落 candidates.md（带 ticket ID 前缀、append 前 grep 去重）
2. 需真机的票加 `rm:pending`，并往 tickets.md `## 待真机验证` 段 append 一条 `- T<n> — <一句话验什么>`
3. **把质量链回报第二行的 `qc-metrics: …` 原样抄到该票那条**（与 `qc:done` 同一口径）。⛔ 别重算、别改格式——它是「小票该不该减配质量链」的唯一样本来源，commit body 留不住（squash 连分支一起删）
4. 在该票那条上写 `qc:done`（行内或其缩进子项，别处不算）
5. 勾 `[x]`

⛔ **`rm:pending` 必须排在 `qc:done` 之前**：重入相位表拿 `qc:done` 当「记账已完成」的锚，它若在后，恰在两者之间 /clear 就会被「有 `qc:done` 无 `[x]` → 补勾」**永久跳过**真机登记，且丢失静默（stage-4 收口只认该段登记过的票）。

⛔ **车道模式下这份清单还多一步「已知碰撞面登记」，同样必须排在 `qc:done` 之前**；收口测试也不按批、按轮且有硬上限——两条都在 `lane-mode.md`，**漏做不会有任何东西变红**。

**收口测试**：本批全回合完后，**一次**跑该批相关测试 + typecheck（**整仓全量回归的唯一落点**）。理由：前几次回合的结果都被最后一次覆盖，逐票各跑是重复劳动，而归并后这棵树还没人验过。**你自己跑、丢后台，多久都行**。测试红了先读 `recovery.md` 判假红；真要修也在那里（worktree 已拆）。

**推进下一批前自检**：本批每票都有自己那笔 commit + `qc:done` + `[x]`、本 flow 的 worktree 全拆、无未裁决的决策/安全项。（**车道模式下这条不一样**，见 `lane-mode.md`）

### 连续执行

批与批、票与票之间**都不做「要不要继续」式 check-in**——过了自检直接算下一批。唯一停点是第 4 步的安全/拍板 fork。（落盘、记账、开收 worktree 是必做调度动作，不算 check-in）

## 输出规格

每票一笔代码 commit + `tickets.md`/`candidates.md` 的记账（规格见「元规则」与第 3/6 步）。验证是机器门 `scripts/gate-stage-3.cjs`（fail-closed）——**七条断言的规格、理由、报错怎么改都在脚本里，取那份**；违规处置见 `recovery.md`。

## 完成条件

机器门 fail-closed 拦得住的（全部 `[x]` 且各有 `qc:done`、worktree 全拆、历史线性）不必自查。**需要你自己保证的**：

- **本 stage 期间问开发者拍板的结论已逐条落盘**：新增决策写进 `spec.md` 的 `## Decisions`；改了范围 / 已对齐结论的走 `revision-protocol.md` 回写 `alignment.md`。/clear 之后这些结论还在不在全看它——不落盘等于没问过。
- **问了但没答的，同样要落盘**：写进 `spec.md` 的 `## Pending Decisions`——`## Decisions` 放已拍板的、照做，它放悬而未决的；下个 session 撞上同一问题先来这里看「是不是问过、没答」（实测 9 条悬置项只活在 HANDOFF、`spec.md` 0 条 ⇒ /clear 后被重问）。

## Signal

**触发条件**：全部 `[x]`，**或**开发者明确表示完成。
**动作**：用 Write 向 `<FR>/state/signal` 写 `done`。引擎跑机器门（`gate-stage-3.cjs`）通过后**自动进 stage-4**（本 stage 无人工 gate）。
