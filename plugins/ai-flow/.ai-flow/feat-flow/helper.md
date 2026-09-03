# feat-flow

## 这是什么

**功能需求的 AI-coding 工作流**。基于 Claude Code 的 ai-flow 引擎实现，覆盖从需求确认到知识沉淀的 6 个阶段。

## 核心使命

按重要性排序：

1. **保障需求的交付质量高**：通过结构化决策、TDD 实施、缺陷右移的多层独立审查（架构审查 + 组装级双视角 + 3 轮验证）、可验证 AC 等机制，让每次交付都经得起审视
2. **团队能按一套规范落地和实践**：固定的 6 stage 流水线 + 文档结构 + 工具调用约定，让不同人在不同需求上产出一致质量
3. **context 长期保持净正向**：通过 ADR 治理、CLAUDE.md 漂移修复、注释保鲜等机制，确保项目越大 AI coding 越好，而非越差

## 设计哲学（贯穿所有 stage）

| 原则 | 含义 |
|------|------|
| **/clear 安全持久化** | 任一 stage 后 /clear 不破坏下游。所有跨 stage 信息必须落盘文件 |
| **ADR 查阅协议** | 每个 stage 入场扫 docs/adr/ 注入相关 ADR，避免 AI 重新提议已被否决的方案 |
| **待沉淀术语** | Stage 4 task 间术语传递，避免命名漂移 |
| **知识 context 归置** | 命中以下 4 类才升 context 层：缘由类（非显然选择或绕过更自然做法）、否定类（验证某方案不可行）、约定类（不确定是否已记录的命名/架构惯例）、边界类（依赖外部条件、条件变化会静默失效）——各类按 ADR / rules / CLAUDE.md / skill 路由，同时命中时多者均记 |
| **持久产物自包含** | 代码注释 / 对外 commit message / 写入 context 层的知识（CLAUDE.md / rules / ADR）面向没有本次 session、也不翻 docs/feat-flows/ 的未来读者，**不得引用 flow 内部临时指代**（`Task N` / `U<k>` / `Phase X` / 「见上文」/ `design.md D-xx` / ADR 编号裸引用 等）——要表达就展开成实质内容。flow 内归档（task-reports.md / 开发者汇总表）不受限。判据与清理统一在 ai-flow 内置 `comment` skill（stage-4 写时守 + stage-5 收尾专职清理 pass；机制见 skill、取最新） |
| **从零自建基建** | 首次跑就建知识基础设施（docs/adr/、CLAUDE.md），不等开发者手动建 |
| **stage 提示词有硬预算：渲染后 ≤ 10,000 字符** | 宿主内联注入的上限（按**字符**不按字节，实测夹逼出来的，见 `src/lib/prompt-render.ts` 的 `INLINE_INJECTION_BUDGET`）。超了宿主就落盘、只回注约 2,000 字符预览，而**没有任何东西告诉模型「还有 90% 没给你」**——掉在边缘之外的恰好是那些「违反了也不会有东西变红」的规则。feat-flow 的 stage-3/4/5 曾长期超限（1.3×–1.6×，实测溢出 59 次），现已拆成「常驻页 + 按触发事件分的 references」。**分页原则**：常驻页只留主循环 + 静默红线，其余按**可观察的触发事件**下放，页首「岔路 → 先读哪份」路由表必须整个落在前 2,000 字符内。⛔ **红线不许往 references 搬**。预算、路由可达性、路由表位置、红线清单、全 flow 文档与脚本的断链，全部由 `tests/stage-prompt-budget.test.ts` + `tests/flow-doc-integrity.test.ts` 机器执行 |
| **缺陷右移到最早可捕获点** | 每类缺陷在信息最早齐备的 stage 抓：需求理解→stage-1，架构/复用→stage-2，局部 bug→stage-4 每 task，组装级（跨 task 一致/集成/需求闭环/整体安全）→stage-5。同一缺陷不在多 stage 重复地毯审 |
| **3 轮验证** | 派发+综合处理记为轮 1；轮 2 由独立 reviewer 复核修复，范围 = 修复 commit 的 diff ∪ 重跑该 finding 的可复跑判据（前者验「修得对不对」，后者验「覆盖全不全」）；轮 3 仅裁剩余分歧。硬上限 3 轮，之后仍有分歧就上报开发者、不再循环。安全类 Critical/High 的修复另有一次 report-only 窄复核 |
| **前置产物修订** | 中后期 stage 发现「前面已对齐的东西要改」时（开发者异议 或 AI 自查），按 L1（abort）/ L2（回改 + 下游兜底）/ L3（inline）分级，并评估对**全部**上游产物的影响，禁止 AI 自判 L3 后默默改；回改一律覆盖为当前态，产物正文不留「原本…改成…」演化叙事（审计交给 git，详见 `references/revision-protocol.md`） |
| **`git add -A` 前先核范围** | 本 flow 有**四处** `git add -A`（stage-4 折回 `[partial]` commit、**stage-5 环节 A 的回归修复 commit**、stage-5 环节 C 的 squash、stage-6 approve 后的沉淀 amend），**全都跑在主工作树上**。monorepo 的主树随时可能带着与本 flow 无关的改动（别的子项目、别的工具生成的、开发者手改的），`-A` 会把它们一并吞进本 flow 那笔 commit——而**本 flow 没有任何机器门会拦**（stage-3/4 无 completion 校验，stage-5/6 只有人工 gate）。所以每次 `git add -A` 之前逐条核对 `git status --porcelain`：**本 flow 范围** = `git diff --name-only <base_sha_code>..HEAD`（**stage-5 环节 C 必须在 `git reset` 之前就记下来并写进 review.md**——reset 后 HEAD==base，这个 diff 会变空，且要跨 /clear 保留）∪ `docs/feat-flows/**`（本 flow 的记账产出，**必须纳入**，别排除掉）∪ `.ai-flow/**`（flow 定义；**flow 运行中升级过插件或跑过 `/ai-flow:update` 就会有它**，这些文件是被 git 跟踪的、只有 `state/` 被 ignore，**同样必须纳入**——本 flow 没有「每笔 commit 必须归属某 task」的机器门，所以它也可以单独 commit 掉，但别把它当范围外的 stray 卡在那里问开发者）。落在范围外的改动 → **不 add，停下问开发者**，别一把 `-A` 吞进去。⚠️ **环节 A 那处最危险**：它吞进来的 stray 落在 `<base>..HEAD` 区间内，于是环节 C 按这个区间算「本 flow 改动范围」时会把 stray **算成范围内**，环节 C 自己的 scope 核对随即全绿放行。⚠️ 吞进去之后极难发现：squash 完那笔 `feat:` commit 看起来就是「本次功能」的全部，diff 里多出来的别处改动没人会怀疑。 |
| **禁止子代理隔离 worktree** | 任何 stage 派发子代理（`Agent` 工具）时，不使用 `isolation:"worktree"`。理由是 feat-flow 的执行模型**本身**不并行：它用的 SDD 禁并行 implementer，耦合的 task 在 Stage 3 已被合并进同一簇、由同一个子代理做完，所以没有需要隔离的并发写。而 `isolation:"worktree"` 建的树不受本 flow 管理（不会被后续 stage 感知，子代理若改过东西也不一定被清掉，留成游离分支/工作树）。⚠️ 别把这条读成「引擎做不到 worktree」——引擎能正确判定目录是否在隔离工作树内（`isInsideLinkedWorktree`），`base_sha_code` 在工作树下也照常框得住 diff，grill-flow 就是按票/按组开工作树并行的。feat-flow 不开是因为不需要，不是因为不能。⚠️ **「没有并发写」只在正常路径成立**：`/clear` 不会杀掉在飞子代理，重入后为同一 task 续派就会有两个子代理写同一棵主树——feat-flow 靠 `references/subagent-lifecycle.md` 的重入判据挡这个，而不是靠工作树隔离 |

## 命令速查

```sh
feat-flow start <自然语言需求描述>   # 启动新 flow，引擎生成 flow_id (<日期>-<rand4>)
feat-flow approve                    # 通过当前 Gate
feat-flow abort                     # 中止当前 flow（创建快照分支；会跑 git add -A，非日常操作）
feat-flow resume <branch>           # 从 abort 的快照分支捡回被中止的 flow（要带分支名）
feat-flow status                    # 查看当前 stage 和状态
feat-flow help                      # 查看本文档
```

⚠️ **`/clear` 之后不需要敲任何命令**：引擎的 SessionStart hook 会自动恢复到当前 stage（注入 `[ai-flow:paths]` + 当前 stage 提示词）。`resume` 是另一回事——它只能从 `abort` 留下的快照分支恢复，且要求当前**没有** active flow；`/clear` 之后 flow 仍然是 active 的，对它敲 `resume` 只会得到「已有 active flow，请先 abort」，⛔ **别照那句去 abort**——你要恢复的东西早就恢复好了，而 abort 会跑一次 `git add -A` 并把快照提交到新分支。

## 6 Stage 流水线

| ID | 名称 | Gate | 关键工具 |
|----|------|------|---------|
| stage-1 | 需求确认（接地式问询 / load-bearing 结论走 AskUserQuestion / 术语表 / 需求源摄入 / ADR 查阅 / 项目命令 / TDD 基建 / UI / 独立审计） | ✅ | figma MCP + tavily-extract/lark-doc（需求源）+ general-purpose（调研/审计） |
| stage-2 | 实施蓝图（+ 独立架构/复用审查 + 生成开发者对齐视图 tech-design.md / .html，入场问一次、默认轻量；视图含**代码库改动面**文件级清单，呈给开发者前跑一次**陌生读者可读性审查**） | ✅ | feature-dev:code-architect + general-purpose（架构审查）+ general-purpose（可读性审查，只读视图）+ mermaid/mmdc（配图，`references/assets/mermaid-theme.json` 定主题与正交直角布局（ELK，mermaid 除默认 dagre 外的第二个布局引擎，11.14.0 起随 mermaid-cli 自带）） |
| stage-3 | 实施计划（plan 原生格式：decisions 切片 + 执行单元；AI 内部三轮 review（Round 3 只裁「维持」项，维持集为空且耦合边界一致时可跳过）+ 七项检查，任一项残留即为分歧、落盘 plan.md「待开发者决策」节、停下等开发者拍板） | ❌（无 Gate；有分歧时靠「不写 signal」软停，无引擎兜底） | general-purpose（三轮内部 review）；self-review checklist 内联，无外部 plan skill |
| stage-4 | 代码实施（按执行单元串行派、机械拼装、截断自保护、子代理生命周期把关） | ❌（无 Gate） | subagent-driven-development + optimize-claude-context（implementer 子代理跑 assess-candidate 沉淀知识） |
| stage-5 | 质量门（回归 + 组装级双视角 + 人审闭环：集成闭环 + 强制安全 + 真机验证清单收口 + 人工 review 在工作区 diff→修复→最终 CR→squash 成单 feat 提交） | ✅ | general-purpose（集成 + 安全 双视角）+ receiving-code-review + optimize-claude-context（assess-candidate 源头过滤 context 候选） |
| stage-6 | 知识沉淀（增 / 修 / 退役；代码已由 stage-5 squash） | ✅（汇总表即 gate 呈现，approve 后把知识沉淀 amend 进 feat 提交、结束流程） | optimize-claude-context（handle-one-directive 单工具覆盖 CLAUDE.md/rules/skills/ADR 全 4 层） |

## 产出文件路径

```
docs/feat-flows/<flow_id>/
├── design.md                # 需求 / 决策记录 / 术语表 / UI 状态 / 项目命令 / AC（Stage 1 起累积）
├── architecture.md          # 模块定位 / 接口 / 数据流 / build 顺序（Stage 2）
├── tech-design.md/.html     # 开发者对齐视图：术语表靠前 / 现状落位图 / 提议方案(机制可感知) / 实施路径 / 决策台账附录速查（Stage 2 Gate 主审面；从 md 生成的单向视图，重生成而非手改）。两种形态内容契约相同，轻量(默认)出 Markdown + mermaid 围栏，完整出 HTML + SVG 与查看器
├── plan.md                  # Task 列表（Stage 3 起，Stage 4 维护 [x] 进度）；Stage 3 内部 review 若留下未决分歧，追加「## 待开发者决策（Stage 3）」节——这是无 Gate 的 stage-3 «停下等开发者» 状态的唯一落盘依据，/clear 重入靠它恢复
├── task-reports.md          # Stage 4 每 task 的元信息累积（新术语 / ADR 候选 / 待人工验证 等）
├── review.md                # 审查结论 + 待开发者决策 + 真机验证清单收口（Stage 5）
└── context-delta.md         # Context 变化提案（Stage 2 创建，Stage 5 追加，Stage 6 读取）

.ai-flow/feat-flow/state/
├── active.json              # 引擎维护（flow_id、current_stage、base_sha 等；含 base_sha_code 字段：Stage 4 起点 SHA，由引擎在 mark-base 触发时捕获，stage 不直接写）
├── current-prompt.md        # **最近一次落盘时那个 stage** 的提示词渲染副本（占位符已展开、写盘长度纪律已在内）。只在「提示词超注入上限」与「gate-pending 重入」这两条指路路径上生成；每次 stage 推进与 flow 收尾都会删掉它。文件开头有 `stage=<id>` 头——**与你当前 stage 不符就是旧件，别照它执行**
├── signal                   # AI → 引擎 完成信号（内容语义化，见下方说明）
├── mark-base                # AI 写此 marker → 引擎捕获 HEAD 为 base_sha_code（Stage 4 Step 1）
└── flow.log                 # 引擎的单一事件日志（`appendLog` 写入，每行 `<ISO 时间> [<flow>] [session=<id>] <事件>`）。
                             #   记的不只是 stage 切换，而是引擎全部可观测行为：
                             #   stage 生命周期（STARTED / ADVANCED / APPROVED / COMPLETED / RESUMED / ABORTED）、
                             #   session 归属与恢复（SESSION / SESSION_NORMAL / SESSION_READONLY /
                             #   SESSION_GATE_PENDING / SESSION_SELF_HEAL_* / SESSION_END）、signal 与 gate
                             #   （SIGNAL_INTERCEPT / SIGNAL_INVALID / GATE_SIGNAL_WRITTEN / POSTTOOL_GATE_PENDING）、
                             #   写入拦截与越界（NON_OWNER_WRITE_BLOCKED / SCOPE_VIOLATION / BLOCKED / CWD_MISMATCH）、
                             #   signal 放行与推进（SIGNAL_ALLOW / POSTTOOL_SIGNAL_ADVANCE）、
                             #   base 捕获（BASE_CAPTURED / BASE_CAPTURE_FAIL）、gate script 结果（SCRIPT_FAIL /
                             #   APPROVE_SCRIPT_OK / APPROVE_SCRIPT_FAIL）、abort（ABORT_REFUSED_WORKTREES /
                             #   ABORT_ERROR）、context 收尾阈值（CONTEXT_WRAP_UP，带 pct/threshold；
                             #   ⚠️ 尾巴恒为 `first`，跨线只写这一行、没有 repeat 变体）、
                             #   以及 hook 内部异常 ERROR

**signal 文件语义**：AI 统一写入固定关键词 `done`，引擎自动计算下一步：
- 任意 stage 完成（包括最后一个 stage）→ 写 `done`
- 引擎会拒绝非 `done` 的写入（幻觉防护：AI 不需要知道 stage id）
- signal 存在且为 `done` = 当前 stage 已申请推进

写入后有两种行为，由 stage 配置决定：
- **有 Gate 配置的 stage**：引擎暂停，等待开发者 `feat-flow approve`。**顺序铁律**：approve 提示由引擎在 signal 写入后回注，AI 只能在写 signal、收到引擎「已提交」确认之后才呈现摘要 + 提示 approve；未写 signal 时 `approve` 会被引擎拒绝（见 `commands/approve.ts`）。这条铁律由引擎在注入任何 gated stage 提示词时**自动追加**（`prompt-render.ts` 的 `gateProtocolNote()`，覆盖 start / advance / session 恢复 / resume 四处注入点），不写在各 flow 的 stage `.md` 里——所以新 flow 经 `/ai-flow:create` 创建后也自动具备，flow 作者无需手写
- **无 Gate 配置的 stage**：引擎立即推进，AI 无需等待开发者确认。**引擎没有「条件 gate」这种原语**（`gate` 是静态布尔，见 `src/lib/flow-schema.ts`），也**没有反向 stage 转移**——所以「某些情况下才停下等开发者」只能由 AI 用**不写 signal** 软停实现，并且必须把「在等什么」落盘（stage-3 有分歧时写 plan.md 的「待开发者决策（Stage 3）」节，就是这个机制；无 Gate 的 stage 也不该提示开发者 `approve`，那会被引擎拒绝）

session 恢复时引擎会读取 signal 内容自动识别当前状态（gate 等待、自愈推进或正常恢复）

docs/adr/                    # Stage 6 写入；首次出现 ADR 候选时由 handle-one-directive 按需创建目录 + README 索引
<deepest-common-ancestor>/CLAUDE.md  # Stage 6 写入（monorepo 兼容路径解析）
```

## 环境要求

### 必需 skills

用 `ls ~/.claude/skills/` 检查：
- `subagent-driven-development` — Stage 4 实施
- `test-driven-development` — Stage 4 实施（**硬依赖**：`references/dispatch-unit.md` 刻意不内联红绿步骤、只点名这个 skill，所以它缺失时实施子代理拿不到任何 TDD 指引——先写实现、`verify` 照样退出 0、没有任何东西变红。preflight 会检测）
- `receiving-code-review` — Stage 5 处理反馈
- `optimize-claude-context` — Stage 6 治理全 4 层 context：CLAUDE.md + .claude/rules/ + .claude/skills/ + **ADR**（其 `handle-one-directive` 的 Priority 4 路由到 ADR，自带跨层冲突检测、ADR 重叠 → 原地更新 / supersede、README 索引维护；来自 [darian-deng/agent-skills](https://github.com/darian-deng/agent-skills)）

### 必需 plugins

- `feature-dev` — 提供 code-architect（Stage 2 蓝图）subagent

> Stage 2 的架构/复用审查、Stage 5 的集成与安全双视角审查均用内置 `general-purpose` 子代理（审查专长写在 stage 提示词里），不依赖额外插件。

### ai-flow 本身（已自带）

- `create` / `update` / `add` / `optimize-stage-prompt` skill

### 可选但推荐

- `tavily-search` / `tavily-extract` — Stage 1 外部技术调研
- figma MCP — Stage 1 UI 设计读取

### 系统

- Node.js ≥ 18
- git
- claude CLI（feat-flow 仅在 Claude Code 内运行）
- mermaid-cli（`mmdc`）**≥ 11.14.0** — Stage 2 配图渲染（手写 .mmd → mmdc 渲 SVG）：`npm install -g @mermaid-js/mermaid-cli`（preflight **按命令 + 版本**检测，低于下限直接拦）。版本下限来自配图契约用的 `layout: elk`——`@mermaid-js/layout-elk` 从 11.14.0 起才随 mermaid-cli 自带，而更旧的版本**不报错、静默退回默认布局**（退出码仍是 0，配图自检也发现不了，因为它用同一份配置渲染）。用 `mmdc --version` 确认。

## 已知偏离 upstream

stage-3/4 重构详见 `docs/feat-flows/stage-3-4-redesign/design.md`（含对抗审查处置）。简要：

- **plan 原生格式（feat-flow 自有，不依赖 writing-plans；self-review checklist 已内联进 stage-3）**：每 task = `unit`（执行单元 id）+ `done`（行为断言）+ `verify`（Stage 3 预推导，非运行时）+ `read_first` + `decisions`（决策切片，带 `⟵ 来源`）+ `files`（**符号锚点，禁行号**）+ 可选 `depends_on` / `touches_shared` + `output_size` + 可选 `contract`（stub）。plan 末尾含「执行单元清单」。
- **粒度 = 执行单元（最大内聚切片）+ 优先级化拆分轴**：内聚为默认归并，被三轴否决——① 截断防御 > 内聚（单文件一批已枚举成员 / 跨域多接驳 → 无条件拆骨架+填充）② 风险等级独立拆分轴（高风险动作不与低风险清债同单元）③ 跨上下文写冲突拆。废 files 数量硬门（files 仍须可枚举列全）；体量靠「数 architecture 已列明成员」估，未列全则退回 Stage 2。
- **decisions 切片取代 design.md 默认注入**：管每个 task 的决策内联进 plan（矩阵投影 + 四类过滤 + 三道结构门）；design.md/architecture.md 全文降级为 Stage 4 兜底路径。全局性决策（适用全部 task）不特殊转移，按需重复出现在多个 task 的 decisions 里，由 Stage 4 评审侧核查兜底。
- **Stage 4 = 机械执行器**：按执行单元串行派（**绝不并行**）、dispatch 机械拼装、`touches_shared` 注入前序指针（commit sha + 文件路径，implementer 自己 `git show` 查看，不由主 session 转述 diff 正文）、**截断自保护协议**（近上限先 commit + 写「剩余工作」清单，续跑读清单不做 git 考古）、耦合簇内逐 task commit/verify + 越界升簇并集层、verify 假绿检测。
- NEEDS_CONTEXT 处理严于 SDD 默认（一次重 dispatch 失败即 escalate 开发者，不允许主 session 凭空补答；反复缺护栏 = decisions 漏 → 回补 plan）。
- **flow 归属靠 session→锚点绑定**（引擎按 session_id 反查锚点，cwd 漂移/cd 到任意目录都不会认错 flow）；stage 提示词里的 flow 路径用引擎注入的绝对 `{{project_root}}` / `{{flow_root}}` 锚定，故 **cd 不再受限**。引擎只在控制面（signal / active.json / scripts）保留写保护。

## 异常恢复

`/clear` 后或新 session 进入：引擎自动注入 flow_id / current_stage / requirement + 重读 stage prompt（见 `session-handler.ts`）。多-task stage 通过 plan.md 的 `[x]` 标记恢复进度。⛔ **但 `[x]` 不是全部**：`/clear` 不杀在飞子代理，所以 stage-4 重入时必须先按 `references/subagent-lifecycle.md` §三 确认上一轮那个子代理死没死，才能为未 `[x]` 的 task 续派——否则两个子代理同写一棵主工作树，commit 归属错乱且没有机器门会拦。
