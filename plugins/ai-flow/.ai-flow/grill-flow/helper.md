# grill-flow

## 这是什么

**mattpocock/skills v1.1 方法论在 ai-flow 引擎上的完整实现**——散文 spec（不锁实现）+ tracer-bullet 垂直切片 + 主 session 调度 fresh 子代理逐票实施（写集不相交的票各开一个 worktree 并行，决策点人在环），配结构化质量把控。

**实现规模不限**；**设计迷雾大**（一次 grilling 聊不出 spec）走 stage-1 的 wayfinder 子模式。

## 核心内核（"轻"在哪、质量在哪）

- **轻 = mattpocock 内核**：散文 spec 不搞接口枚举、tracer-bullet 不搞字段矩阵、提示词薄（细节在 references/）。执行沿用子代理派发（主 session 只调度、context 干净），差异化落在上游散文 spec + tracer-bullet 竖切。
- **单一读者原则**：`stages/stage-3.md` 是**调度页**（主 session 读：算批次、开收 worktree、回合、记账、拍板）；`references/per-ticket-review.md` 是**一票交付契约**（子代理读：质量链、自适配、机器门格式）。两者不互相复述——细节复述必漂移。
- **质量把控齐**：per-ticket simplify + Standards/Spec/correctness 三轴评审子代理并行 + 注释清理 + 客观地板（假绿检测/枚举负空间/回归）；stage-2 对抗性方案审查；收尾组装双轴 + 安全专项（对抗立场 + 阻塞项独立复核）；集中沉淀。

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
| stage-3 | implement | script（无 gate，fail-closed） | 主 session 调度：算批次（够格 ∧ `Touches` 不相交，上限 3）→ 落 `batch:` 再派发 → 每票一个 worktree（`scripts/worktree.cjs open`）→ 子代理按契约走完质量链并 commit → 回合前自己 `git rebase` 适配 → 主 session `--ff-only` 逐票回合（`close`）→ 批次收口测试一次 → 记账。**历史必须线性**（断言④ 是 `-X ours` 静默丢内容的唯一物理防线）。**执行单位可切换**：`scripts/schedule.cjs` 按主循环同一套准入算法模拟两种模式的轮数，谁少用谁——写集重叠多时「一组一车道」（长驻 worktree `R<n>`、`close --keep` 逐票回合、记 `lane:`）会明显更快。判据与三条代价见 stage-3「执行单位」节 |
| stage-4 | code-review | **gate** | A 全量测试 + B 组装双轴+安全 + C 开发者 IDE 未暂存 diff 亲审闭环**（含真机验证清单收口 rm:pending，全流程唯一真机验证落点）** → squash 一笔 feat commit |
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
├── tickets.md           # tracer-bullet 切片 + 依赖/写集声明（Blocked by / Touches，stage-2 建）+ 进度（stage-3 维护 batch:（车道模式 lane:）+ qc:done + [x] + 真机票 rm:pending/rm:done + ## 待真机验证段）
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
- **`.gitignore` 需含两条规则**，`/ai-flow:add` 会写入（写在 git 根，monorepo 子项目锚点同样覆盖）：
  - `.worktrees/` — 0.50.0 之前的隔离工作树位置。**新落点在仓库同级**（`../<repo 名>.ai-flow-worktrees/`），所以这条规则对新 flow 已经不起作用；保留它是为了兼容升级前开出去、还在跑的树，以及开发者手动在那儿建的工作树——落在仓库内又没被 ignore，stage-4 的 `git add -A` 会把整个 worktree 目录当嵌套仓库吞进 squash commit（只 warning 不报错，落地是个空的 gitlink 条目）。落点在仓库内时 `worktree.cjs open` 仍会先检查这条。
  - ⚠️ **为什么把落点搬出仓库**：模块解析（node 与 tsc 都逐级向上找 `node_modules`）在 worktree 嵌在主检出内部时会走出 worktree、落到主树的 `node_modules`，同一个包于是有两个物理路径 = 两份互不相关的同名类型，worktree 里的 typecheck 报一批「同名但不兼容」——与被测改动无关，却会卡住 pre-commit hook、让碰到那些包的票全部提交不了。实测（pnpm workspace）：落点在 `apps/desktop/.worktrees/` 时车道里 71 个错、`--listFilesOnly` 能看到两份 `@types/react`；搬到仓库同级后同一条命令 0 错。查证手段：`tsc -p <config> --noEmit --listFilesOnly | grep <包名> | sort -u`，出现两个不同前缀就是越界。
  - `**/.ai-flow/**/state/` — 这条是**并行的前提**，不只是卫生。少了它，`state/active.json` 会被提交进 worktree，于是 worktree 里的子代理解析到的是一份**陈旧的** flow 状态副本，而不是主仓的真状态。
- **交互式命令在本环境起不来**（无 tty）：`git rebase -i`、`git add -i`、`git add -p` 会挂住或被宿主直接拒。所以凡是要改写历史的地方，文档给的都是非交互形态——`GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash --autostash <base>`。⚠️ 另有一条容易连带踩的：stage-3 期间主树**一直有未提交的记账改动**，`--autostash` 因此不是可选项；漏了它 rebase 直接拒绝，而按报错去提交记账会造出一笔不归属任何票的 commit、被机器门③ 拦下。
- **`git reset` / `git cherry-pick` / `git merge --ff-only` 都是非交互的**，stage-4 环节 C 的摊平与 squash 全用它们——那一段不需要开发者代跑命令。
- **必需 skill**：`optimize-claude-context`（stage-5 沉淀）。
- **内置命令**：`/simplify`（stage-3 per-ticket 机械型质量修，Claude Code 内置）。correctness 轴不用内置命令，改由子代理携未提交 diff 审 bug（通用、见 `references/per-ticket-review.md`）。
- **内置 skill**：`comment`（注释纪律与清理，会真删——实施子代理写时守；stage-3 每票 commit 前编排器显式调用一次；stage-4 环节 C reset 后 + squash 前各一次。机制与判据见 skill 自身、取最新；随 ai-flow 一起装、无需额外安装）。
- preflight 按上述检测；缺失给安装命令并阻止启动。

> **行为真相以本目录（`.ai-flow/grill-flow/`）现版文件为准**（stage 提示词 / references / scripts / config.json）。仓库根 `docs/grill-flow-design.md` 是**设计 rationale 与决策历程档案**——回答「当时为什么这么设计、否掉了什么」，正文的执行模型描述已过时，**不要拿它量实现**。
