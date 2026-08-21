# grill-flow

## 这是什么

**mattpocock/skills v1.1 方法论在 ai-flow 引擎上的完整实现**——散文 spec（不锁实现）+ tracer-bullet 垂直切片 + 主 session 调度 fresh 子代理逐票实施（写集不相交的票各开一个 worktree 并行，决策点人在环），配结构化质量把控。

**实现规模不限**；**设计迷雾大**（一次 grilling 聊不出 spec）走 stage-1 的 wayfinder 子模式。

## 核心内核（"轻"在哪、质量在哪）

- **轻 = mattpocock 内核**：散文 spec 不搞接口枚举、tracer-bullet 不搞字段矩阵、提示词薄（细节在 references/）。执行沿用子代理派发（主 session 只调度、context 干净），差异化落在上游散文 spec + tracer-bullet 竖切。
- **单一读者原则**：`stages/stage-3.md` 是**调度页**（主 session 读：算批次、开收 worktree、回合、记账、拍板）；一票的交付契约分两段给子代理读——`references/per-ticket-review.md`（实施段）与 `references/quality-chain.md`（质量链段）。三者不互相复述——细节复述必漂移。
- **一票走两段，是成本决定的不是分工决定的**：实测（`2026-08-14-kuer`，7 段 session、396 个子代理、按 `message.id` 去重后 17,663 回合 / 4,007M 缓存读）——宿主按「每回合重读全部上下文」计费，而子代理上下文随回合线性累积（实测斜率：fresh 质量链代理前 100 回合 **2.2K/回合**，整段 309 回合摊平后 1.6K/回合——⚠️ 早先这里写的 0.84K/回合找不出对应口径，别再引用）。于是一个从头做到尾的实施代理走到质量链时上下文已堆到 40 万，那一段占掉整票 **43% 的成本**（每回合均价 438K）；同样的活在新开上下文里**起步只付 17K**（缓存读；含新建缓存的总量 45–49K）。顺带消掉「主 session 在实施代理仍跑质量链时提交 → 三评审对着空 diff 全绿」这个静默故障。

  ⚠️ **下面两段的成本口径不同，别混着比**：紧接这一句的「拆开之后的实测」按**代理自己**算（不含它派出去的子孙）；再往下「规模自适应」那一节按**子树**算（含全部子孙）。同一张票两个口径能差 15%——T35 主代理 194M、含子孙 223M。

  **拆开之后的实测**（同 flow 的后续会话，105 个子代理 / 723M 缓存读；**以下均为「仅主代理」口径**）：最大的一票拆分实测 194M（实施 91M + 质量链 103M）。合并版的估法不用外推别的票——第二段那 309 回合平均跑在 333K 上下文上，不拆的话它们要从第一段结束处（517K）往上跑、均值约 613K，差额 309 × 280K ≈ 86M，合并版约 281M，**省约 30%**（末端取 650K/780K、或假设合并省掉 15% 重定位回合，落在 28–33%，故记 **±5pp**）。⚠️ 仍是外推不是 A/B——这批数据里没有同一张票的拆前 / 拆后对照。
  ⚠️ **拆分的理由不是「不拆跑不完」**：该会话唯一一次未拆运行（T34，补做实施 + 质量链挤在一个上下文）跑到 483 回合、峰值 784K，**跑完了**，没撞 1M 墙。它的问题是交付质量——那笔 commit 没达成票面验收判据，主 session 复核后复派补做，又花 50M。⚠️ 它的 prompt 里**已经**逐字内联了 AC、验收方法（全仓 grep）、以及「上一轮没跑过这个检查」的提示，所以不是交接有损；但 n=1，无法从数据上把「上下文退化」与「剩余工作量超出继承清单」分开——**别把这条当机制引用**。
  ⚠️ **已知缺口：第二段没有回合 / 上下文预算。** 契约给的模型是「起步 17K、第 100 回合 274K」，实测三个 fresh 质量链代理在第 100 回合分别 277K / 264K / 262K（均值 268K，对模型误差 2.2%），但它接着跑到第 309 回合、510K——拆分买来的新起点被它自己跑没了。六对配对的第二段/第一段成本比在 0.34×–3.47×（**仅主代理口径**；含子孙的子树口径见下节，是 0.42×–4.38×）之间摆动，没有任何东西约束它。加硬帽子会把票推向「复派」形态，而复派正是本 flow 丢过一次正确性的交接口，所以先没加。
  - ⚠️ **算这类账时必须按 `message.id` 去重**：一次模型响应在 transcript 里被拆成多行（thinking 一行、每个 tool_use 一行），**每行都重复携带同一份 usage**。逐行累加会把回合数夸大约 1.9 倍、成本夸大约 1.7 倍。
- **异步派发的空转有两种，解法相反，别用错**（详见 `references/subagent-lifecycle.md` §一）：
  - **子代理往下派孙代理 → 一律 `run_in_background: false`**：子代理没有「挂起」态，丢后台的父代理只能靠一轮轮 `Bash: true` 空烧着等，而每个空转回合都要为当时的全部上下文付一次全额。实测 157/311 次派发跑在后台 → 422 个纯空转回合，约占全流程 5%。
  - **主 session 派子代理 → 该丢后台**（它是唯一能被唤醒的执行体，不丢后台就腾不出手做 15 分钟巡检）。它的空转解法是**结束回合**，不是改成同步派发：后台命令与子代理完成时宿主会把它叫醒并投递完整回报（实测 4 次，入队到唤醒 3 毫秒）。⚠️ **读成「必须保持在场」的代价实测最贵**：一次运行里主 session 连发 **671 次 `sleep 1`**，占它全部工具调用的 **73%**、输入 token 的 **74.3%**（233.1M / 313.5M），末尾每次空转重读约 65 万缓存 token。诱因不是本 flow 的提示词（普通会话同样复现），是「等」这个动作在上下文里没有可照抄的形状——所以 `subagent-lifecycle.md` §一 末尾给的是**两种正确形状的表**，不是又一条 ⛔。
- **别把大文件的路径发给子代理**：给了路径它就整篇读，读进去之后**此后每一轮都重新计费**。实测 7 段 session 里子代理对 `tickets.md` 做过 **14 次**无 `limit` 的整篇 Read、对 `gate-stage-3.cjs` **15 次**（这两个数可复现：数 transcript 里的 Read 调用）。⚠️ **别引用固定的 token 数**——单次实际带进多少取决于当时文件多大、以及 Read 工具有没有截断（此处曾写过「218,173 字符 ≈ 68K token」，核不出来源：那份文件现在是 137,135 字符 / 249,641 字节，两个都不是 218,173）。**代价不在单次多大，在读进来之后此后每一轮都重新计费**，而其中绝大部分内容那个子代理一次都用不上。票面整段内联、spec 只切相关段、机器门规格取契约里那四条。
- **stage 提示词有硬预算：渲染后 ≤ 10,000 字符**（宿主的内联注入上限，按字符不按字节；实测夹逼出来的，见 `src/lib/prompt-render.ts` 的 `INLINE_INJECTION_BUDGET`）。超了宿主就落盘、只回注约 2,000 字符预览，而**没有任何东西告诉模型「还有 90% 没给你」**——掉在边缘之外的恰好是那些「违反了也不会有东西变红」的规则。引擎对超限的兜底是**不注入截断正文**、改发一条「立刻 Read 真实文件」的指令；预算本身由 `tests/stage-prompt-budget.test.ts` 执行。
- **stage-3 的分页原则（拆分后的常驻/按需边界）**：调度页只留**主循环** + **违反了不会有任何东西变红的红线**；其余按**可观察的触发事件**拆进 references，页首「岔路 → 先读哪份」路由表负责指路，且该表必须整个落在前 2,000 字符内（那样即便这页将来又被写胖到溢出，预览里仍带着完整路由）。⛔ **红线不许往 references 搬**——搬下去就等于把一条静默失效的规则藏到「撞上岔路才读」的位置。这两条由 `tests/flow-doc-integrity.test.ts` 机器执行（红线清单 + 路由可达性 + 路由表位置 + 全 flow 文档的断链检查）。
- **质量把控齐**：per-ticket simplify + Standards/Spec/correctness 三轴评审子代理并行 + 注释清理 + 客观地板（假绿检测/枚举负空间/回归）；stage-2 对抗性方案审查；收尾组装审（Standards / Spec 两轴按规模可跳过）+ 安全专项（强制、任何规模都跑；对抗立场 + 阻塞项独立复核）；集中沉淀。

- **规模自适应目前只有两处，判据都不是「diff 多大」**（本节成本均为**含子孙代理**的子树口径）：① `scripts/schedule.cjs` 选执行单位（票少时自动落回一票一树，实测 ≤9 票时车道模式根本算不赢）；② stage-4 组装审的 Standards / Spec 两轴按规模可跳过（安全专项永不跳）——**判据以 `references/assembly-review.md` 的「派几个先算一次」为准，本页不复述**（阈值与命令一改就会漂）。要点只有两条：判相交**用实际改动文件、不用票面 `Touches` 声明**；跳过只消掉「同文件不同区段」那一类交界面，**「跨票反向读取对」没有机器判法、必须转环节 C 人审**。
  ⚠️ **`simplify` 四轴目前没有减配，是刻意的**。实测它在最小的一张票（13 行 diff）上四个孙代理全部返回「无 finding」、花 0.577M，看着该裁——但**票的大小事前预测不了**（`stage-2.md` 记着：票面声明的改动路径数与实际工作量秩相关 0.15、字数 0.12、六特征回归交叉验证 R² 为负），而现在只有 1 个小票样本。所以改成每票留一行 `qc-metrics:`——由质量链代理回报、主 session 抄进 **tickets.md**（stage-3 记账第 3 项），攒够之后 `grep -rn qc-metrics docs/grill-flows/` 一次性回答「线划在哪」。⛔ **别写进 commit body**：stage-4 的 squash 会 `git reset` 摊平 + 全新 message 重提 + 删票分支，实测那之后 `git log --format=%b | grep -c qc-metrics` = 0。⛔ 在攒够样本之前也不要按 diff 行数减配——划错线的失败方式是静默的。
  ⚠️ **第二段有个规模无关的成本地板**：六对配对回归的截距 3.22M，最小那张票实测 3.71M（是它实施段 0.846M 的 **4.38 倍**）。所以小票的「装置/实干」比天然高，这不是 bug，是拆分 + 三评审 + 四轴的固定入场费。三个最小票平均 4.01×，三个最大票平均 0.95×，六对区间 **0.42×–4.38×**（比值 vs log10(实施成本) 的 r² = 0.72）。

## 两种并行形态（选错会白付一整轮成本）

worktree 并行有两种截然不同的用法，本 flow **都支持**，判据是「拆出来的几块之间要不要共享决策」：

**形态 A · 一个 flow，一个主 session，N 条车道 / N 棵票树**（stage-3 写的就是这个）。主 session 当调度器，实施与评审都在子代理里跑，worktree 由 `scripts/worktree.cjs` 开收。
- 适用：几块**共享同一份 spec 与决策台账**，有跨块依赖或会撞同一批文件。
- 拿到的：`Blocked by` 全局有序、机器门逐票核对（commit ↔ 票 ↔ 写集）、决策只在一处拍、/clear 可恢复。
- 代价：**主 session 是并发瓶颈**——它要读每一份回报、做每一次裁决，并行度再高也过不了这个漏斗；子代理是一次性的（返回即销毁），所以跨票长驻的资源（车道）只能由主 session 持有。

**形态 B · 几个独立 flow，各自一个顶层 session，各占一个 worktree**（业界主流的「多终端并行」，本 flow 同样跑得起来）。在每个 worktree 里各跑一次 `grill-flow start <那一块的需求>`，各走完整 5 stage，最后把各自 stage-4 那笔 squash commit 合回来。
- 机制依据（有测试锁着）：`state/` 被 gitignore，所以每个 worktree 里的 `active.json` 只可能是它自己起的那个 flow；引擎解析 flow 时**先看当前锚点自己有没有 active flow**，有就用它，只有没有时才映射回主检出。两种形态因此不会互相抢。
- 拿到的：**没有单一调度瓶颈**——N 个顶层 session 各有完整 context 预算、各自还能派子代理，人在环的粒度也更细（每块自己拍板）。
- 代价：每块都要重走 stage-1/2（grilling + 方案审查 + 切票）；**跨块的决策一致性没有任何机器保证**（N 份 spec 各自演化）；合并冲突要人解；要同时盯 N 个终端。

**怎么判**：几块之间有跨块 `Blocked by`、共用一份术语表/契约、或会改同一批文件 → **A**。几块各自能独立说清需求、独立验收、合并只是文件层面的事 → **B**。拿不准就按 A：它的机器保护更强，而 B 的每一处代价都要人补。

## 命令速查

```sh
grill-flow start <自然语言需求描述>   # 启动，引擎生成 flow_id
grill-flow approve                    # 通过当前 gate
grill-flow abort                      # 中止（创建快照）
grill-flow resume                     # 新 session 恢复
grill-flow status                     # 查看当前 stage
grill-flow help                       # 本文档
```

## 5 Stage 流水线

| ID | 名称 | 完成方式 | 关键机制 |
|----|------|---------|---------|
| stage-1 | grill（需求对齐，domain-aware） | **gate** | grilling 一次一问 + wayfinder 迷雾子模式 + research/prototype detour |
| stage-2 | spec + tickets | script + **gate** | 散文 spec + seam + User Stories + 对抗方案审查 + HTML 方案视图 + tracer-bullet 切片(prefactor 前置) + 每票声明 `Blocked by`(实施先后) 与 `Touches`(预计写集) |
| stage-3 | implement | script（无 gate，fail-closed） | 主 session 调度：算批次（够格 ∧ `Touches` 不相交，上限 3）→ 落 `batch:` 再派发 → 每票一个 worktree（`scripts/worktree.cjs open`）→ 实施子代理留改动不提交 → 质量链子代理（新上下文）走完质量链并 commit → 回合前自己 `git rebase` 适配 → 主 session `--ff-only` 逐票回合（`close`）→ 批次收口测试一次 → 记账。**历史必须线性**（断言④ 是 `-X ours` 静默丢内容的唯一物理防线）。**执行单位可切换**：`scripts/schedule.cjs` 按主循环同一套准入算法模拟两种模式的轮数，谁少用谁——写集重叠多时「一组一车道」（长驻 worktree `R<n>`、`close --keep` 逐票回合、记 `lane:`）会明显更快。分组来自 `lane:` 字段时它还会校验该分组自己的前提（跨车道写集相交 = 会停等，轮数被低估）并点名「跨车道票」。判据见 `references/execution-unit.md`，车道模式的三条代价与全部动作差异见 `references/lane-mode.md`。`worktree.cjs status <flow_id>` 一屏看全各车道的 `ahead / dirty / 是否 HEAD 后继 / 待补依赖 / 静默时长`（纯读，不 prune；**静默 ≥30 分钟的在飞车道 = 那个子代理已经停了**，这是唯一不依赖自我报告的判据）；**只有主 session 能等待**——子代理结束回合即终止，所以整仓全量回归归收口、纯验证任务不外包（见 `references/subagent-lifecycle.md`）；`sync` / `close` 按「装完时的锁文件指纹」自己检测并补装依赖（`--no-install` 只报不装；补装失败会以非零退出打断命令链，但回合本身已完成、别重跑 close）。记账按票（close 成功即记）、收口测试按轮且有硬上限，两者的落盘锚点分别是 `qc:done` 与 tickets.md 的 `## 收口记录` 段 |
| stage-4 | code-review | **gate** | A 全量测试 + B 组装审（两轴按规模可跳过）+安全 + C 开发者 IDE 未暂存 diff 亲审闭环**（含真机验证清单收口 rm:pending，全流程唯一真机验证落点）** → squash 一笔 feat commit |
| stage-5 | 沉淀 | **gate** | optimize-claude-context 集中写 CLAUDE.md/rules/ADR |

gate：1 / 2 / 4 / 5。script（秒级 fail-closed 结构门）：2 / 3。

## 产出文件

```
docs/grill-flows/<flow_id>/
├── alignment.md         # 需求/范围/决策/术语/暂缓/沉淀候选/功能覆盖缺口(替换迁移型,stage-1)
├── wayfinder-map.md     # 迷雾大时的决策地图（stage-1 wayfinder 子模式，可选）
├── spec.md              # 散文规格：Problem/Solution/User Stories/Decisions/Testing Decisions/Out of scope/方案审查/跨端跨仓行为契约(涉及时,stage-2)
├── tech-design.html     # 方案视图：gate 主审面（stage-2，从 spec 生成的单向视图）
├── diagram/*.svg        # 配图（mermaid→mmdc）
├── tickets.md           # tracer-bullet 切片 + 依赖/写集声明（Blocked by / Touches，stage-2 建）+ 进度（stage-3 维护 batch:（车道模式 lane: + 在飞标记 wip:）+ qc:done + [x] + 真机票 rm:pending/rm:done + ## 待真机验证段 + ## 已知碰撞面段（车道模式下机器门⑦ 失效后的替代保护，stage-4 逐行点名）+ ## 收口记录段（收口测试硬上限的计数依据））
├── candidates.md        # 沉淀候选（stage-3 累积）
└── review.md            # 收尾审 findings + 原始测试输出（stage-4）

.ai-flow/grill-flow/state/   # 引擎维护：active.json / signal / mark-base / transitions.log
../<repo 名>.ai-flow-worktrees/<flow_id>-T<n>/
                             # stage-3 并行票的隔离工作树，在**仓库同级**（不在仓库内，
                             # 所以不需要 gitignore）；分支 wt/<flow_id>-T<n>；
                             # 由 scripts/worktree.cjs open/close 管理，stage-3 结束前必须全部拆除
../<repo 名>.ai-flow-worktrees/<flow_id>-R<n>/
                             # 同上，一组一车道模式下的长驻车道（一组一棵、组内逐票 close --keep）
```

signal 语义：AI 统一写 `done`，引擎自动计算下一步（非 `done` 会被拒）。有 gate 的 stage 写 done 后暂停等 approve；无 gate 的自动推进。

## 环境要求

- **系统**：Node.js ≥ 18、**git ≥ 2.31**、claude CLI、mermaid-cli（`mmdc`，stage-2 配图：`npm install -g @mermaid-js/mermaid-cli`）。
  - git 版本下限是 stage-3 并行带来的：引擎判断「某个目录是否位于隔离工作树内」用的是 `git rev-parse --path-format=absolute`（2.31，2021-03 起）。更低的版本上该判断会安全降级为「否」，后果是 worktree 内的写入不再受控制面保护、signal 拦截与 context 统计约束——**并行路径在那种环境下不能用**（串行路径不受影响）。用 `git --version` 确认。
- **宿主须允许子代理再派子代理**：stage-3 的一票交付契约里，实施子代理自己并行派三个评审子代理、并调用 `comment` skill（后者自身也会 fan-out）。若宿主不给子代理 `Agent` 工具，这套质量链跑不起来。以下四条是这条依赖的**真实边界**，派发前按它们兜底：
  - **嵌套本身是宿主能力，不是必然可用**。Claude Code 在 2026-06 之前明确禁止子代理派子代理，之后开放并给了深度上限（公开说法在 3~5 之间反复过）。所以 dispatch prompt 里**必须带一条降级路径**：派不出嵌套子代理时，就自己按三个轴各审一遍、并在回报里说明是自审。
  - **并发有上限**（默认 20 上下，可由 `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` 覆盖）。每票 = 1 实施 + 3 评审 + `comment` 自己的 fan-out，所以**能同时跑的票数受这个上限压制**，往往比 `schedule.cjs` 算出的最优并发更小。
  - **重复角色的 spawn 会被宿主的分类器直接拦掉**（比对子代理的角色和父代理正在做的事）。三评审之所以派得出去，是因为 Standards / Spec / correctness 三个轴的职责明确不同；把它们写成三个措辞相近的「审一下代码」就会被判重复。
  - **嵌套子代理拿不到 `AskUserQuestion`**。契约里「人在环只在主 session 那侧」这条因此不只是分工，而是宿主约束——子代理遇到要拍板的事只能回报，不能自己问。
- **context 阈值（`config.json` 的 `context` 段）**：`warn_at_pct: 50` / `block_at_pct: 60`。越过 block 之后 `context_blocked` 会**锁进 flow 状态**，此后主 session 对**代码**的写入一律被拒，只有本 flow 自己的 `docs_paths`（`docs/grill-flows/`）仍可写——这是刻意留的，**block 的目的是不让你在退化的 context 上继续产出，不是堵死安全退出**。所以每个 stage（包括 `write_scope: unrestricted` 的）都要配 `docs_paths`，否则触发 block 之后连交接块都写不下去。⚠️ **这道闸只锁主 session**：子代理（hook input 带 `agent_id`）既不参与测量、也不被它拦——上下文是独立的，而「把活交给 fresh context」恰恰是 context 退化时的处方。实测这条曾经缺失（测量侧修了、执行侧漏了）：主 session 在 61% 锁定后派子代理修 7 项，子代理在自己只有 75K（窗口的 7.5%）时被拒，一项做了一半、留下一个没人 import 的新文件。⚠️ 它是给模型的信号、不是安全边界——`Bash` 不在拦截清单里，`cat >` / `sed -i` / `git commit` 一直放行。
  - **交接块只写「算不出来的」。** 车道 HEAD、各车道是否干净、进度计数、剩余票清单、票↔commit 配对、下一票是哪张——这些**一条 `worktree.cjs status <flow_id>` 加两条 grep 就能算出来**，写下来只会过期。实测那份手写现场段有四处失准，**全部落在可探测字段上**：进度计数写成「61 张完成 51」而实际是 60/49（同一句里的剩余清单却是对的）；记下的车道 sha 在文件被写下的那一分钟就已经被 amend 掉了；同一段里两份互相矛盾的剩余清单；散文写的车道归属与票面 `lane:` 字段冲突。
    **必须写的只有 git 里没有的那几样**：①「在飞但还没 commit 的票是哪张」——子代理从派发到 commit 之间车道分支毫无变化，git 只看得到「树脏」，看不到脏的是哪一票（这一项用票面的 `wip: R<n>` 字段落盘，比写进散文更不会过期，而且它是在**派发之前**写的，那时 context 还健康）；② 在飞子代理的越界发现与待问清项；③ 已裁决但还没写进票面的结论；④ 三端测试基线数字（要跑一遍才知道）；⑤ **截断票的剩余工作**——它只出现在实施代理的回报里，git 里只看得到一笔带 `[partial]` 的 commit、看不到还差什么（用票面 `rest: <差什么/做到哪>` 落盘，与 `wip:` 同口径）。⚠️ **它的写入时机不在本清单的「close 后记账」那一刻**——截断票按定义还没 close；它写在**收到实施代理回报、判出 `[partial]` 的那次机械判定里**（`stage-3.md` 主循环第 4 步），续做轮又截断时刷新同一字段。**完成状态不在 `rest:` 里**：由票面 `impl:done` 承载（有 = 剩余已做完），`rest:` 本身不退役、不标注。⛔ `rest:` 是 `reentry.md` 续派判据和 `quality-chain.md` 形态乙那条 fail-closed 的**共同键**——两者不是相互独立的两道防线，主 session 把它误标一次两道一起哑。
    **触发时机是「每票 close 后的那次记账」，不是「clear 之前」。** 记账本来就在写 tickets.md，顺手把这几行刷新一次即可；押在 clear 前那一刻会让它跟着那一刻的意外一起丢——实测有一次主 session 在阈值触发后才想起要写，而那时最要紧的三件事只能说进聊天里，`/clear` 销毁的正是聊天。
  - ⛔ **`/clear` 的真实代价不是零**：flow 状态与 commit 都在磁盘上、都活得下来，但**在飞子代理的回报活不下来**——它的判断型发现、真机验证项、安全红线自查结论无法从它留下的那笔 commit 反推。实测撞过一次：session 在有子代理在飞时越过阈值，那份回报就此丢失。所以越过阈值的第一件事是**把在飞状态写进 tickets.md**（哪条车道在做哪票、哪些子代理**还在跑**、三端测试基线、已经做出但还没落盘的裁决），然后再 `/clear`。
- **`.gitignore` 需含两条规则**，`/ai-flow:add` 会写入（写在 git 根，monorepo 子项目锚点同样覆盖）：
  - `.worktrees/` — 0.50.0 之前的隔离工作树位置。**新落点在仓库同级**（`../<repo 名>.ai-flow-worktrees/`），所以这条规则对新 flow 已经不起作用；保留它是为了兼容升级前开出去、还在跑的树，以及开发者手动在那儿建的工作树——落在仓库内又没被 ignore，stage-4 的 `git add -A` 会把整个 worktree 目录当嵌套仓库吞进 squash commit（只 warning 不报错，落地是个空的 gitlink 条目）。落点在仓库内时 `worktree.cjs open` 仍会先检查这条。
  - ⚠️ **为什么把落点搬出仓库**：模块解析（node 与 tsc 都逐级向上找 `node_modules`）在 worktree 嵌在主检出内部时会走出 worktree、落到主树的 `node_modules`，同一个包于是有两个物理路径 = 两份互不相关的同名类型，worktree 里的 typecheck 报一批「同名但不兼容」——与被测改动无关，却会卡住 pre-commit hook、让碰到那些包的票全部提交不了。实测（pnpm workspace）：落点在 `apps/desktop/.worktrees/` 时车道里 71 个错、`--listFilesOnly` 能看到两份 `@types/react`；搬到仓库同级后同一条命令 0 错。查证手段：`tsc -p <config> --noEmit --listFilesOnly | grep <包名> | sort -u`，出现两个不同前缀就是越界。
  - ⚠️ **从旧落点搬迁时不要在旧路径留软链接**（`0.50.0` 之前落点在 `<锚点>/.worktrees/`，搬迁的人常留一个指向新落点的软链接兜底）。`.gitignore` 只挡 git，**挡不住任何遍历文件系统的工具**：仓内的扫描器（文档链接检查、导出面比对、路径存在性校验）会跟着软链走进整棵车道树，把同一批文件重扫一遍、并因路径基准错位报出一批假失败——而这些目录在 CI 的干净检出里根本不存在，于是那道闸「**在每台开发机恒红、在 CI 里恒绿**」，这是最坏的一种门禁，会训练人忽略它。实测发生过，只能单开一张票去修那个扫描器。`worktree.cjs` 的 `sync` / `close` 本来就认旧落点，软链接并不必要；末票 `close`（不带 `--keep`）现在会顺手删掉旧路径上的悬挂软链接。
  - `**/.ai-flow/**/state/` — 这条是**并行的前提**，不只是卫生。少了它，`state/active.json` 会被提交进 worktree，于是 worktree 里的子代理解析到的是一份**陈旧的** flow 状态副本，而不是主仓的真状态。
- **交互式命令在本环境起不来**（无 tty）：`git rebase -i`、`git add -i`、`git add -p` 会挂住或被宿主直接拒。所以凡是要改写历史的地方，文档给的都是非交互形态——`GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash --autostash <base>`。⚠️ 另有一条容易连带踩的：stage-3 期间主树**一直有未提交的记账改动**，`--autostash` 因此不是可选项；漏了它 rebase 直接拒绝，而按报错去提交记账会造出一笔不归属任何票的 commit、被机器门③ 拦下。
- **`git reset` / `git cherry-pick` / `git merge --ff-only` 都是非交互的**，stage-4 环节 C 的摊平与 squash 全用它们——那一段不需要开发者代跑命令。
- **必需 skill**：`optimize-claude-context`（stage-5 沉淀）。
- **内置命令**：`/simplify`（stage-3 per-ticket 机械型质量修，Claude Code 内置）。correctness 轴不用内置命令，改由子代理携未提交 diff 审 bug（通用、见 `references/per-ticket-review.md`）。
  ⚠️ 它编译在 CLI 二进制里、磁盘上没有对应文件，preflight 检测不到，**照文件系统搜必然搜不到**——实测有质量链代理据此判「本机没装」、以自审顶替。调用形式与两条防误伤写在使用点（`references/quality-chain.md` 第 0 步）。由此立一条通则：**凡在使用点提到外部能力，写「怎么调」而不只是「叫什么」**——内置命令写明「内置」+ `Skill` 调用形式；插件 skill 给 `plugin:skill` 全名（`ai-flow:comment` 就是范本，从没被误解过）；本 flow 自派的子代理写明是自派、并点名它**不是**哪个同名的现成命令。信息写在 `helper.md` 里不算数：质量链代理是全新上下文，只拿到 `quality-chain.md`。
- **内置 skill**：`comment`（注释纪律与清理，会真删——实施子代理写时守；stage-3 每票 commit 前编排器显式调用一次；stage-4 环节 C reset 后 + squash 前各一次。机制与判据见 skill 自身、取最新；随 ai-flow 一起装、无需额外安装）。
- preflight 按上述检测；缺失给安装命令并阻止启动。

> **行为真相以本目录（`.ai-flow/grill-flow/`）现版文件为准**（stage 提示词 / references / scripts / config.json）。仓库根 `docs/grill-flow-design.md` 是**设计 rationale 与决策历程档案**——回答「当时为什么这么设计、否掉了什么」，正文的执行模型描述已过时，**不要拿它量实现**。
