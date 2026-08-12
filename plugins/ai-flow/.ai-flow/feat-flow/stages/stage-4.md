# Stage 4：代码实施

> feat-flow 第 4/6 步 · [流程总览](../helper.md)
> 当前 stage 目的：按 plan.md 执行单元（1 task 或耦合簇）串行实施，每 task 一个 commit，全部由子代理完成

## 目标

调用 `subagent-driven-development`（下称 SDD）的「fresh subagent + 单次评审」模型编排执行 plan.md：**按执行单元（1 个独立 task 或 1 个耦合簇）串行派发**，每个单元由 fresh 子代理实施 + 一次评审（同时产出规格、质量两个 verdict）。**主 session 只做调度**——读 plan.md（含执行单元清单）/ task-reports.md、**机械拼装** dispatch prompt（plan 已自带 decisions/verify/files，不即兴）、记录结果；代码的读写和测试全部发生在子代理里，禁止主 session 直接写代码。

## 前置读取

- `{{project_root}}/docs/feat-flows/<flow_id>/plan.md` — 主 session 读它拿 **task 列表 + 执行单元清单**；plan.md 的每 task 已自带 `decisions` / `verify` / `files` / `output_size`，dispatch 时机械拼装、不再运行时即兴补信息

design.md / architecture.md **不在主 session 读取，也不再默认注入子代理 prompt**——管每个 task 的决策已由 Stage 3 抽成 `decisions` 切片内联进 plan。design.md / architecture.md 全文**降级为兜底路径**：仅当某 task 的 `decisions` 切片不足、子代理报 `需补充信息` 时，才作为路径给出（见「异常处理」）。主 session 提前读会污染 context，并诱导在主 session 内联写代码。

## 入场动作

**先判首次进入还是 /clear 重入**：看引擎注入的 `[ai-flow:paths]` 块里是否已有 `base_sha_code` 行（Step 1 触发引擎捕获后才会注入它），或 plan.md 是否已有 `[x]`。

- **注入 context 已含 `base_sha_code`，或 plan.md 已有 `[x]`** → 这是 /clear 重入：**跳过下面 Step 1**（绝不重跑——重新捕获会污染 Stage 5 的 diff 基准；引擎也会在已存在时拒绝覆写）。改为：读 task-reports.md 重建待沉淀术语 → 从第一个未 `[x]` 的 task 续跑主循环（按执行单元清单确定它属哪个单元/簇）。其中：
  - 遇到**已 commit 但 task report 缺失 / 不全的 task**（无 `**审查**` 行，或缺 `context 候选` / `ADR 候选` 等只有子代理能产出的字段）→ 派一个子代理读 `git show <sha>` **重跑评审 + 重跑 assess-candidate**，据回报重建该 task report。主 session 不读代码、跑不了 assess-candidate，故这类字段必须由子代理重建；重跑安全（diff 已含该 task 最终改动）。
  - 遇到 task-reports.md 里有 **`[partial]` commit + 「剩余工作」清单**的 task（截断自保护留下的）→ 按清单续跑该 task，**不做 git 考古**（见「截断自保护」）。
  - Step 0 的分支复核仍要做。
- **注入 context 无 `base_sha_code` 且 plan.md 无 `[x]`** → 首次进入，按 Step 0 → 3 顺序走。

**Step 0：分支 + 工作树预检（任何 commit 之前）**

```sh
git branch --show-current
git status --porcelain
```

- **分支**：当前在 `main` / `master`（或仓库默认分支）→ **停下，要求开发者先 checkout 一个需求分支再继续**。绝不在 main 上落任何一笔 commit（连下面起点的 docs commit 也不行）。
- **工作树**：输出非空且含**代码文件**改动 → 停下问开发者：「检测到工作树有未提交的代码改动，是上次 task 执行中途崩溃的残留，还是预期的中间状态？请确认如何处理。」（仅 docs/feat-flows/ 改动属正常）

**Step 1：起点 commit + 触发引擎记录 base_sha_code**

```sh
git add {{project_root}}/docs/feat-flows/<flow_id>/
git commit -m "docs: <feature> stage1-3 outputs"
```

docs 提交后，**用 Write 工具写 `{{flow_root}}/state/mark-base`（内容任意，如 `capture`）**。引擎据此在「docs 已提交」的此刻捕获 `git rev-parse HEAD` 作为 `base_sha_code`，写入引擎状态并注入后续 context——**stage 自己不碰 active.json**（active.json 是控制面，直接写会被引擎拒绝）。引擎确认后会回注一行 `base_sha_code: <sha>`。

把 Stage 1-3 累积的 docs 一次性提交；`base_sha_code` 是 Stage 5/6 的代码 diff 起点（只看代码、不看 docs）。它由引擎管理、随 flow 生命周期绑定——新 flow 自然不会读到上个 flow 的基准 SHA。若引擎回报捕获失败（无提交等），先确认 docs commit 已成功再重写 mark-base。

**Step 2：初始化 task-reports.md**

```sh
touch {{project_root}}/docs/feat-flows/<flow_id>/task-reports.md
```

每 task 完成后主 session 把 task report 追加进来——这是跨 /clear 保留 task 级元信息的唯一手段。

**Step 3：定位 ADR 目录**

按 `{{flow_root}}/references/adr-scan.md` 定位本仓库的 ADR 目录 / 读索引，**知道有哪些 ADR（标题 + 状态）** 即可。**不在此处一次性选定**——每个 task 涉及的模块不同、相关 ADR 也不同，相关性筛选放到每个 task 的 prompt 构造时做（见下）。

## 主循环：用 SDD 逐执行单元串行执行

调用 `subagent-driven-development`（SDD）的「fresh subagent + 单次评审」模型执行 `plan.md`，但**派发粒度是 plan 末尾的「执行单元」，不是单个 task**：

- **单元 = 1 个独立 task** → 一个 fresh subagent 做这一个 task。
- **单元 = 耦合簇（多个 task）** → 一个 fresh subagent 在同一上下文里连续做完整簇，但**簇内仍逐 task commit、逐 task 跑 verify**（见「耦合簇执行」）。

每个单元通过 `Agent` 工具 dispatch（`subagent_type='general-purpose'`）。

**模型分层（降本提速、质量不降）**：
- **实施子代理**：`model='sonnet'`（1M context）。依据：plan 已把 `decisions` / `verify` / `files` 喂到位，实施退化为机械执行 + TDD 红绿棘轮兜底，故执行侧可用更便宜的模型；它又是 token 大头（读文件 + 写码 + 跑全量测试 + 多轮红绿），降这里省得最多、提速最明显。该单元 plan 标了 `output_size: large` 或 `effort_hint: high`（截断防御 / 跨域多接驳 / 高风险隔离 / 非枚举型复杂度）时，在 dispatch prompt 里原文点出这个信号，提示实施子代理这个单元复杂度更高、需要更仔细——**这只是 prompt 里的自然语言提醒，不是技术层面的参数调节**（`Agent` 工具不支持按次覆盖 effort，effort 只能预置在 subagent 类型定义文件里，`general-purpose` 是内置类型改不了；本设计不为此引入自定义类型）。
- **评审子代理**：保持强——`model='opus'`，**绝不与实施侧同档**。依据：评审是让实施侧敢用更便宜模型的质量门（抓越界 / 假绿 / 注释 / spec 偏离），它只读 `git show` 的 diff、本身很便宜，降它省不了多少却拆掉整道安全网。

**钉死串行（修并行 race）**：**绝不并行 dispatch 实现子代理**。SDD 本就禁并行 implementer；耦合的 task 已被 Stage 3 合并进同一簇/同一子代理，不存在「并行两个子代理改同一文件」的场景。即使两个单元无文件交集，也串行派，不并行。

**dispatch = 机械拼装**：plan 的每 task 已自带 `decisions` / `verify` / `files`（符号锚点）/ `read_first`，主 session **照着拼 prompt，不即兴构造、不补 plan 没给的信息**。要补的信息缺失 = plan 缺信息 = 走异常处理，不在 dispatch 时现编。

**开跑前**：解析 plan.md 的 task 列表 + 执行单元清单——解析到 0 个 task 或无执行单元清单 → 停下问开发者（疑似 plan.md 损坏或 Stage 3 未完成）。

**抑制 SDD 的越界默认行为**（feat-flow 接管这些，不让 SDD 冲出 stage-4 边界）：
- **不建 worktree**——feat-flow 在当前工作树跑（引擎按 session 绑定定位 flow、用 base_sha_code 框定代码 diff，worktree 会另起工作树、base_sha 基准失效）
- **不调用 `finishing-a-development-branch`**——merge / PR 收尾归 Stage 6 + 开发者
- **不跑 SDD 的「整体 final reviewer」**——整体审查是 Stage 5 的职责（`base_sha..HEAD` + 组装级双视角审查），在此重复且可能给出打架结论
- **continuous execution 的边界**：SDD 默认「task 间不停顿、不向开发者要确认」——这指**不做「要不要继续」式的人类 check-in**，**不等于**省略主 session 每 task 之间的落盘 / 待沉淀术语重组 / 审查行回填。这几步是必做的调度动作，不算 check-in，不要为「连续执行」跳过

**子代理走 TDD**：若该 task 在 plan.md 标了走 TDD，implementer 子代理按 `test-driven-development` 实施。

**TDD task 的 dispatch prompt 必须减重**（红绿循环多步 + plan 段易内嵌代码块，叠加最易在子代理首轮工具调用前就撑爆上下文）。在常规〔精选来源〕之上再裁三条：① **不粘贴代码块**（plan 本就只有结构化字段，子代理按 `files` 符号锚点自己 Read）；② **不内联红绿步骤**（只点名「按 test-driven-development 实施」，过程在该 skill 里）；③ **不塞完整 report 模板**（子代理只按末尾〔精简回报形状〕返回，主 session 自己映射）。

非 TDD task 仅受 ① 约束（已是〔精选来源〕通用规则），②③ 不适用。

**状态报告用中文**：implementer 用「完成 / 完成但有顾虑 / 受阻 / 需补充信息」四种状态报告（对应 SDD 的 DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT）。

**dispatch 前预处理**（每个单元都做，机械执行，不即兴补信息）：

1. **`read_first` 动态校验**：读该单元各 task 的 `read_first` 列表，对每个路径 `ls <path>` 验证存在。文件不存在时：检查 plan.md 是否有前置 task 的 `files: Create` 包含该路径——**有则判为预期前置产物**（prompt 标注"此文件由前置 task 创建，若前置已完成应已存在"，不阻断）；**无则判为计划错误**（停下告知开发者，不继续 dispatch）。

2. **`touches_shared` → 注入前序指针**：读该单元各 task 的 `touches_shared` 列表（Stage 3 已标）。对其中每个前序 task，从 task-reports.md 取其 commit sha + 涉及的共享文件路径，作为「文件 `<path>` 已被 Task M（commit `<sha>`）改过，你须自己执行 `git show <sha> -- <path>` 查看该改动，在其基础上修改、勿覆盖」注入 dispatch prompt——**只给指针，不读取 diff 正文**（主 session 提前读全文会像 design.md / architecture.md 全文一样污染 context；这一步在 Stage 4 可能连续跑十几个 task 的长会话里尤其累积）。这是防「后续 task 覆盖前序成果」的机械步骤。

3. **`verify` 直接取自 plan（不再推导）**：plan 的每 task 已含 `verify` 字段。直接把它作为「本 task 实施后必须运行、退出码 0 即验收」注入 prompt，**并加假绿检测要求（仅对测试选择器型 verify）**：若 `verify` 是带测试选择器的命令（含 `-t` / `--testNamePattern` / `-grep` / `-k` 等），子代理须确认它**实际匹配到 ≥ 1 个测试**（0 匹配 = 选择器写错的假绿，按 `需补充信息` escalate）。非测试型 verify（如 stub 的 `tsc --noEmit`、lint）只看退出码 0，不适用「匹配测试数」检查。

4. **`decisions` 机械注入**：plan 该 task 的 `decisions` 切片**整段拼进 prompt**（它就是管这个 task 的护栏，已含接口契约/命名/AC/为何不选 X）。stub task 的 `contract` 字段（若 plan 单列）一并带入。**不再默认注入 design.md / architecture.md 全文路径**——仅子代理报 `需补充信息` 时作兜底给出。

**每个单元的 implementer prompt = 机械拼装 plan 已有字段**（不即兴、不批量加载全文）：
- 该单元各 task 的标题/编号 + `done`（行为级验收）+ `verify`（来自预处理 3，含假绿检测要求）
- **`decisions` 切片整段**（来自预处理 4——这是管本 task 的全部护栏，子代理必须遵守；含接口契约/命名/AC/为何不选 X）
- 已校验的 `read_first` 文件列表（预处理 1）；`files` 的符号锚点（`@ 导出名`，子代理按锚点直读对应符号，不读整文件）
- 如有 `touches_shared`：前序指针（预处理 2——commit sha + 文件路径，「自己 `git show` 查看、在此基础上改、勿覆盖」，不含 diff 正文）
- 如有 `contract`（stub）：前置契约约束
- plan.md 路径（**仅供看前后 task 上下文，禁止跨 task 拿活**）
- **该 task 相关的 ADR**：拿本 task 涉及的文件 / 模块，对照 Step 3 拿到的 ADR 索引（标题 + 状态）做相关性匹配，挑出相关 ADR 的**路径**（≤5 条）传给 implementer 按需读；主 session 自己不读 ADR 全文。每 task 各自选
- **待沉淀术语**：前置 task 累积的「新术语或模式」（主 session 每次 dispatch 前重新组装，见下文）
- **不默认给 design.md / architecture.md 全文路径**——`decisions` 已是切片；仅子代理报 `需补充信息` 时作兜底补给（见异常处理）
- 提示：用 `git log` / `git show <commit>` 看前置 task 已实现的细节

**聚焦约束**（写进 prompt）：专注当前 task，不探索范围外的代码或议题；优先按 task `files` 里的符号锚点（`@ 导出名`）直读对应符号，不读整文件；用 `git show` 看前置 diff，不读整文件。

**实施要求**：
- 实施完成后跑该 task 的 `verify` + **全量单元测试**（design.md 项目命令.单元测试），不只当前 task 新写的
- **verify 假绿检测（仅测试选择器型）**：若 `verify` 带测试选择器（`-t`/`--testNamePattern`/`-grep`/`-k` 等），跑后须确认**匹配到 ≥ 1 个测试**；0 匹配 = 选择器写错的假绿 → 报 `需补充信息`。非测试型 verify（`tsc --noEmit`、lint）只看退出码 0
- 既有单测挂了：默认当作回归，**修代码而非改测试**
- 极少数确信测试在测实现细节（而非行为）→ 报 完成但有顾虑 附理由（必须复核）
- **不跑** lint / typecheck / 集成测试（Stage 5 职责）
- **复用优先 + 最简实现**：写新代码前先 grep 相邻 / 共享模块，已有 helper 直接调用、不重复造；只写完成本 task `done` 所需的最简实现——不加可推导的冗余状态、不留死代码、不复制粘贴改两行。**仅限本 task 范围**——需泛化底层机制属架构级，留给 Stage 5，不在此越界重构
- **注释规则**：照 **`comment` skill（ai-flow 内置 `skills/comment/`，判据的单一权威源）**——注释只服务无本次 flow 上下文（不翻 `docs/feat-flows/`）的未来维护者；默认不写、只留代码表达不了的「缘由 / 否定 / 约定 / 边界」四类、命名/类型/结构能表达的不写、lint/路径规则已强制的不写；**自包含**禁指向 flow 临时产物（`Task N` / `U<k>` / `Phase X` / `见上文` / `design.md D-xx` / ADR 编号），要留就展开实质、不写指针；commit message 同此（`task-reports.md` 等 flow 内归档不受限）；改代码同步修 / 删失准的相邻注释。
- **单元是耦合簇时**：见「耦合簇执行」——簇内**逐 task commit、逐 task 跑 verify**，不是一坨做完只 commit/verify 一次
- **知识沉淀（测试通过后、返回前——你在代码里，故由你做）**：识别本 task 引入、命中『缘由 / 否定 / 约定 / 边界』4 类的知识（非显然选择含为何不选 X · 验证某方案不可行 · 不确定是否已记录的命名/架构/接口约定 · 依赖外部条件会静默失效），对每条调用 `optimize-claude-context` 的 `assess-candidate`，只把它保留的**幸存候选 + 路由（目标层 + 理由 + file:line）**纳入精简回报（其余由 skill 自理，不必回报）。跳过：调试试验 / 临时绕过 / 个人偏好。

**截断自保护**（无法静态预估的大 task 的运行时兜底；可预估的已由 Stage 3 `output_size: large` 拆分避免）：子代理近上限、或发现 task 比预期大时**别硬撑到被截断**——先 `git commit` 已完成部分（message 标 `[partial]`）+ 在 task-reports.md 写「剩余工作」清单（差哪些、做到哪、从哪继续）+ 报 `完成但有顾虑` / `受阻`。

主 session 续跑：**读清单，不做 git 考古**；续跑 prompt = 原 task decisions/verify + 剩余清单 + 「前半已 commit 在 `<sha>`，接着做」。续跑子代理完成后**不新建 commit**，用 `git add -A && git commit --amend` 折回那个 `[partial]` commit（串行下它必是 HEAD）并去掉 `[partial]` 标记——保住「一 task 一 commit」不变量（下游 `git show <sha>`、Stage 5 diff 全依赖它），最终 SHA 记进 task report 的 `**Commit**`。

**耦合簇执行（单元含多个 task 时）**：

一个 fresh subagent 在同一上下文里连续做完整簇（共享 decisions 并集 = 消漂移），但**不得牺牲 per-task 质量基建**：

- **逐 task commit**：簇内每个 task 各自一个 commit（不是一坨），保留回滚/审查粒度——簇内 task A 错了不必连累 task B。
- **逐 task 跑 verify**：簇内每个 task 各跑自己的 `verify`，保留 per-task 行为闭环。
- **越界检查升到「簇 `files` 并集」层**：簇内 task 间互相写对方文件属正常协作，单 task 越界检查在簇内失效；改为对比簇 `files` 并集，并**要求子代理回报「每个 task 实际碰了哪些文件」**供细粒度核对（见精简回报形状）。
- 簇内每个 task 都各自落一份 task report（与独立 task 同格式）。

**子代理的精简回报形状**（写进 prompt——子代理只回这几项，不背完整 report 模板）：状态（完成/完成但有顾虑/受阻/需补充信息）+ commit SHA + 改了哪些文件做了什么（一两句）+ verify 结果（含匹配到几个测试）+ 本 task 引入的新术语/模式（无则「无」）+ **知识沉淀：幸存的 context / ADR 候选及其 assess-candidate 路由（目标层 + 理由 + file:line；无则「无」）** + 顾虑或受阻原因（无则「无」）。**单元是耦合簇时**：每个 task 各回一组（commit SHA + **该 task 实际碰了哪些文件** + verify 结果），供越界并集层核对。下面〔task report 格式〕里 `前置修订` 由**主 session** 据这份回报 + diff 补全；`context 候选` / `ADR 候选` **直接取子代理回报里的 assess-candidate 路由，主 session 只记录、不重判**（理由见下「知识沉淀的归属」）。

**立即落盘**：子代理精简回报到手后**立即**落盘到 task-reports.md（`## Task N: <标题>`），再读 diff 补全剩余字段。若 /clear 落在补全中途（commit 已在、report 不全）——由入场恢复规则重建（见「入场动作」）。

**单次评审**（SDD 自带，一次读 diff、同时产出规格 + 质量两个 verdict；feat-flow 额外要求落盘）：评审结束**立即**把两个 verdict 回填到 task-reports.md 该 task 的 `**审查**` 行，不得延后。主 session dispatch 下一个 task 前，先确认上一 task 已有 `**审查**` 行（没有则先补跑评审再回填）。补跑评审时，使用 task report 中记录的 commit SHA 执行 `git show <sha>` 获取该 task 的 diff，不依赖当前工作树状态。

**diff 截断时的处理**：`git show <sha>` 默认只带 3 行上下文，若某处改动被截断在函数/逻辑块中间、仅凭可见的上下文判断不了正确性，允许用 Read 工具定位到那个具体区域读一小段（不是整个文件），并在评审报告里注明读了哪里、为什么——不因为看不全就放弃判断或凭空猜测。

**「无法从 diff 判断」的处理**：若某项 verdict 是「无法从 diff 判断」（该项要求落在本次未改动的代码里，reviewer 单看 diff 判不出），主 session 不得当 PASS 也不得当 FAIL 直接放过——须自行读相关代码核实后再落最终 PASS/FAIL，并在 `**审查**` 行该项后加注 `（主 session 核实）`。

**注释治理不在每 task 评审里顺带做**：历史证明"多轴评审里稀释的一条"会漏（某次 feat-flow 源码留了 54 处进程指代）。每 task 只做**写时预防**（实施子代理守「注释规则」，见上），真正的**清理统一由 stage-5 环节 C 显式调用 `comment` skill 做**（专职；机制见 skill、取最新）；per-task commit message 会在 stage-5 squash 时被自包含的最终 message 取代，不必在此逐条核。

**规格 verdict 的额外检查维度**：在 SDD 单次评审产出的规格 verdict 基础上，叠加「越界检查」——
- **文件范围越界**：commit diff 中是否包含不在本 task `files` 字段范围内的文件修改？（`git show <sha> --name-only` 机械检查）。**单元是耦合簇时**：对比对象改为**簇 `files` 并集**，并结合子代理回报的「每个 task 实际碰了哪些文件」做 per-task 核对（簇内 task 互写对方文件属正常协作，写到簇并集之外才算越界）。
- **行为越界**：diff 中是否存在与本 task `done` 语义无关的新增函数 / 方法（对比 diff 中新增的函数/方法名是否超出 `done` 断言所描述的行为范围）？
- **枚举负空间检查**：若本 task 的 `done` / `decisions` 蕴含一个有限枚举集（N 个错误码 / N 个状态 / N 路分派），逐项核对 diff 是否每项都有实现 + 对应测试断言，缺项即 FAIL——diff-only 审查只看「写了什么」，此项补审「该写而没写的」负空间（实施侧降档后最易漏的失败模式）。
- **全局性决策核查**：若本 task 的某条 `decisions` 是全局性质（约束全部 task 的规则——如版本下限、命名规范、安全红线，而非本 task 专属的功能点决策），额外核对 diff 里的实现有没有违反它——全局性决策不因为只列在这一个 task 的 `decisions` 里就降低核查强度（Stage 3 不再把全局决策特殊转移，它就和其他决策一样按需重复出现在多个 task 里，这里是唯一的机械兜底）。
越界发现 → 规格 FAIL，要求 subagent revert 越界部分后重新 commit。

**知识沉淀的归属**：知识沉淀本身由 implementer 子代理在 task 终态完成（见〔实施要求〕的「知识沉淀」条——它在代码里，满足 `assess-candidate` 的契约）。主 session **不自己跑 assess-candidate、不重判**（主 session 不读代码，litmus / comment-check / lint 毕业都无现场依据），只把子代理回报的**幸存候选 + 路由**记入 task report 的 `context 候选` / `ADR 候选` 字段。

**主 session 每 task 终态后按此序处理（串行 checklist，避免并发判断导致漂移）**：

1. 收到子代理精简回报 → **立即**落盘到 task-reports.md（`## Task N: <标题>`，见上「立即落盘」）
2. 据回报 + diff 补全 `前置修订` 字段；把回报里的幸存候选 + 路由记入 `context 候选` / `ADR 候选`（不重判）
3. 跑评审 → 回填 `**审查**` 行（见上「单次评审」）
4. 确认本 task 段完整后，再 dispatch 下一执行单元

## task report 格式（每 task 完成后主 session 立即落盘）

implementer 报 完成 / 完成但有顾虑 后，主 session **立即**把下面这段追加到 `task-reports.md`。无内容的字段填「无」。**这是主 session 的落盘模板，不是 dispatch prompt 的一部分——绝不整段塞进子代理 prompt**（子代理只按〔实施要求〕末尾的精简回报形状返回，主 session 据此 + diff 补全本模板各字段）：

```markdown
## Task N: <task 标题>

**状态**: 完成 | 完成但有顾虑
**Commit**: <commit-sha>
**日期**: YYYY-MM-DD
**审查**: 规格 PASS|FAIL，质量 PASS|FAIL

### 新术语或模式
本 task 引入的术语 / 命名规范（如 "LRUEvictionPolicy"）——后续 task 靠它避免命名漂移

### context 候选
子代理 assess-candidate 判定该进 context 层的幸存候选；每条带目标层 + 理由 + file:line（rules/<domain>.md | CLAUDE.md | skill）

### ADR 候选
子代理 assess-candidate 路由到 ADR 的候选（跨文件、有权衡）——Stage 6 评 ADR

### 前置修订
本 task 自查发现前置 stage 问题时填：L1/L2/L3 + 描述 + 处理（见 revision-protocol.md 入口 B）

### 遗留顾虑
状态为 完成但有顾虑 时填
---
```

**为什么必须立即落盘**：这些字段是后续 task（待沉淀术语）和 Stage 6（候选收集）的输入。主 session 内存里的 task report，/clear 后即丢——只有落盘才能跨 /clear 重建（入场重建待沉淀术语就是从这个文件读，不依赖对话历史）。

## 待沉淀术语注入（每次 dispatch 前）

dispatch 第 N 个 task 前，主 session：读 `task-reports.md`（**从文件读，不依赖对话历史**）→ 合并每个已完成 task 段的 `### 新术语或模式` 字段 → 作为精选来源里的「待沉淀术语（未正式入 rules）」注入下一个 implementer。这样后续 task 看得到前面沉淀的术语，避免命名漂移。

## 异常处理

**pre-commit hook 冲突**（因 build 顺序中间态导致的 hook 失败,不等同"受阻"）：某次 task/簇内单个 commit 因仓库的 pre-commit hook（如全量 typecheck）失败时：
1. **先判因**：能否在 plan.md 的执行单元 / `depends_on` build 顺序链条里指出具体依据——即这是本 task 设计上必然产生的中间不可编译态（如本 task 先删列、consumer 要等后续某 Task 才补），而不是本 task 自己引入的新问题？**只能引用 plan.md 里的具体 task 依赖关系作依据，不许仅凭"报错看起来像已知那种失败"就下判断**。
2. **依据成立** → 用 `git commit --no-verify` 完成本次提交，commit message 里注明跳过了哪个 hook 及原因（如 `[intermediate, pre-commit hook bypassed: typecheck — consumer fix lands in Task N]`）。继续主循环，不停下问开发者——这类中间态是 plan 设计本身预期的。
3. **依据不成立**（报错原因在已知链条之外，疑似本 task 真引入的问题）→ 不许套用本条跳过 hook,按下方「受阻」正常处理。
4. **为何可以安全默认跳过**：Stage 5 环节 A 强制跑全量 lint / typecheck / 测试,会补跑到这次被跳过的检查；环节 C 会把 base 之后全部 commit squash 成一个 `feat` commit,被跳过 hook 的中间 commit 不会永久留在最终历史里——跳过不等于永久漏检,只是把检查时点从"每个中间 commit"推迟到"这条 build 顺序链条闭合时 + Stage 5"。

**需补充信息**（严于 SDD 默认）：
1. 查答案是否在三份 docs / 该 task 相关 ADR 里
2. **在** → 改 prompt 加更明确指向（**此处即给 design.md / architecture.md 兜底路径**——decisions 切片不足时，把全文路径补给子代理按需读），重 dispatch 一次；仍 需补充信息 → 停下问开发者
3. **不在** → 直接停下问开发者，**不许凭空补答案**（主 session 的信息源就是这些 docs；子代理读了还问 = 文档真缺信息 = 主 session 也编不出）。**若反复缺的是某 task 的护栏 → 是 Stage 3 的 `decisions` 切片漏了，走 `{{flow_root}}/references/revision-protocol.md` 入口 B 回补 plan**

**受阻**：按 SDD 规则尝试一次（补 context / 换更强模型 / 拆 task / plan 错则上报开发者）；同一 task 第 2 次 受阻 → 停下问开发者。

**重 dispatch 前**（受阻 / 需补充信息 重试）：先确认工作树状态——上次尝试若留下未提交改动，先决定 reset 还是保留，并把这个决定写进重 dispatch 的 prompt（否则会与 Step 0「工作树非空」预检在重入时叠加误报）。

**自查前置 stage 问题**（运行时随时可能触发）：implementer 或主 session 发现前置 stage 漏 / 错 → 走 `{{flow_root}}/references/revision-protocol.md` 入口 B（已含「L2 改了上游后评估已完成 task 是否需 fix-up task」的兜底）。**L1 / L2 必须停下等开发者**——stage-4 无 Gate、又自动连跑，更要主动停，不能借「连续执行」冲过去；**L3** 才 inline 修 + 在 task report 的「前置修订」字段注记。

## 收口（全部 task 完成后）

最后一个 task 的审查行回填后：**不进 SDD 的收尾流程**（不跑 final reviewer、不调 `finishing-a-development-branch`）→ 直接核对下面「完成条件」→ 写 signal。整体质量审查交给 Stage 5。

## 输出规格

- plan.md 所有 task 标 `[x]`，每 task 一个 commit
- `active.json` 含 `base_sha_code` 字段（Step 1 写入）
- `task-reports.md` 累积全部 task report（Stage 6 从此读 ADR 候选 / 新术语或模式 / context 候选）

## 完成条件

- plan.md 所有 task 标 `[x]`
- `active.json` 含 `base_sha_code` 字段
- 全部 task 都有对应 commit
- `task-reports.md` 含全部 task report（每 task 一段，含 `**审查**` 行）

## Signal

**触发条件**：本阶段「完成条件」全部满足，**或**开发者明确表达本阶段已完成。
**动作**：用 Write 工具向 `{{flow_root}}/state/signal` 写入 `done`（引擎接受此关键词，自动推进）。
