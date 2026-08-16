# 派发一个执行单元：预处理、prompt 拼装、实施要求

> **触发**：stage-4 主循环要 dispatch 下一个执行单元（1 个独立 task 或 1 个耦合簇）。**每个单元都从头走一遍本文件**。
> 读者是主 session。`<flow_root>` = 本文件所在目录的上一级。

## 模型分层（降本提速、质量不降）

- **实施子代理**：`model='sonnet'`（1M context）。依据：plan 已把 `decisions` / `verify` / `files` 喂到位，实施退化为机械执行 + TDD 红绿棘轮兜底，故执行侧可用更便宜的模型；它又是 token 大头（读文件 + 写码 + 跑全量测试 + 多轮红绿），降这里省得最多、提速最明显。该单元 plan 标了 `output_size: large` 或 `effort_hint: high`（截断防御 / 跨域多接驳 / 高风险隔离 / 非枚举型复杂度）时，在 dispatch prompt 里原文点出这个信号，提示实施子代理这个单元复杂度更高、需要更仔细——**这只是 prompt 里的自然语言提醒，不是技术层面的参数调节**（`Agent` 工具不支持按次覆盖 effort，effort 只能预置在 subagent 类型定义文件里，`general-purpose` 是内置类型改不了；本设计不为此引入自定义类型）。
- **评审子代理**：保持强——`model='opus'`，**绝不与实施侧同档**。依据：评审是让实施侧敢用更便宜模型的质量门（抓越界 / 假绿 / 注释 / spec 偏离），它只读 `git show` 的 diff、本身很便宜，降它省不了多少却拆掉整道安全网。

每个单元通过 `Agent` 工具 dispatch（`subagent_type='general-purpose'`）。

## dispatch 前预处理（每个单元都做，机械执行，不即兴补信息）

1. **`read_first` 动态校验**：读该单元各 task 的 `read_first` 列表，对每个路径 `ls <path>` 验证存在。文件不存在时：检查 plan.md 是否有前置 task 的 `files: Create` 包含该路径——**有则判为预期前置产物**（prompt 标注「此文件由前置 task 创建，若前置已完成应已存在」，不阻断）；**无则判为计划错误**（停下告知开发者，不继续 dispatch）。

2. **`touches_shared` → 注入前序指针**：读该单元各 task 的 `touches_shared` 列表（Stage 3 已标）。对其中每个前序 task，从 task-reports.md 取其 commit sha + 涉及的共享文件路径，作为「文件 `<path>` 已被 Task M（commit `<sha>`）改过，你须自己执行 `git show <sha> -- <path>` 查看该改动，在其基础上修改、勿覆盖」注入 dispatch prompt——**只给指针，不读取 diff 正文**（主 session 提前读全文会像 design.md / architecture.md 全文一样污染 context；这一步在 Stage 4 可能连续跑十几个 task 的长会话里尤其累积）。这是防「后续 task 覆盖前序成果」的机械步骤。

3. **`verify` 直接取自 plan（不再推导）**：plan 的每 task 已含 `verify` 字段。直接把它作为「本 task 实施后必须运行、退出码 0 即验收」注入 prompt，**并加假绿检测要求（仅对测试选择器型 verify）**：若 `verify` 是带测试选择器的命令（含 `-t` / `--testNamePattern` / `-grep` / `-k` 等），子代理须确认它**实际匹配到 ≥ 1 个测试**（0 匹配 = 选择器写错的假绿，按 `需补充信息` escalate）。非测试型 verify（如 stub 的 `tsc --noEmit`、lint）只看退出码 0，不适用「匹配测试数」检查。

4. **`decisions` 机械注入**：plan 该 task 的 `decisions` 切片**整段拼进 prompt**（它就是管这个 task 的护栏，已含接口契约/命名/AC/为何不选 X）。stub task 的 `contract` 字段（若 plan 单列）一并带入。**不再默认注入 design.md / architecture.md 全文路径**——仅子代理报 `需补充信息` 时作兜底给出。

## implementer prompt = 机械拼装 plan 已有字段

不即兴、不批量加载全文。清单：

- 该单元各 task 的标题/编号 + `done`（行为级验收）+ `verify`（来自预处理 3，含假绿检测要求）
- **`decisions` 切片整段**（来自预处理 4——这是管本 task 的全部护栏，子代理必须遵守；含接口契约/命名/AC/为何不选 X）
- 已校验的 `read_first` 文件列表（预处理 1）；`files` 的符号锚点（`@ 导出名`，子代理按锚点直读对应符号，不读整文件）
- 如有 `touches_shared`：前序指针（预处理 2——commit sha + 文件路径，「自己 `git show` 查看、在此基础上改、勿覆盖」，不含 diff 正文）
- 如有 `contract`（stub）：前置契约约束
- plan.md 路径（**仅供看前后 task 上下文，禁止跨 task 拿活**）
- **该 task 相关的 ADR**：拿本 task 涉及的文件 / 模块，对照入场 Step 3 拿到的 ADR 索引（标题 + 状态）做相关性匹配，挑出相关 ADR 的**路径**（≤5 条）传给 implementer 按需读；主 session 自己不读 ADR 全文。每 task 各自选
- **待沉淀术语**：读 `task-reports.md`（**从文件读，不依赖对话历史**）→ 合并每个已完成 task 段的 `### 新术语或模式` 字段 → 作为精选来源里的「待沉淀术语（未正式入 rules）」注入。这样后续 task 看得到前面沉淀的术语，避免命名漂移
- **不默认给 design.md / architecture.md 全文路径**——`decisions` 已是切片；仅子代理报 `需补充信息` 时作兜底补给（见 `stage-4-exceptions.md`）
- 提示：用 `git log` / `git show <commit>` 看前置 task 已实现的细节

**聚焦约束**（写进 prompt）：专注当前 task，不探索范围外的代码或议题；优先按 task `files` 里的符号锚点（`@ 导出名`）直读对应符号，不读整文件；用 `git show` 看前置 diff，不读整文件。

**状态报告用中文**：implementer 用「完成 / 完成但有顾虑 / 受阻 / 需补充信息」四种状态报告（对应 SDD 的 DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT）。

## TDD task 的 dispatch prompt 必须减重

红绿循环多步 + plan 段易内嵌代码块，叠加最易在子代理首轮工具调用前就撑爆上下文。在常规〔精选来源〕之上再裁三条：① **不粘贴代码块**（plan 本就只有结构化字段，子代理按 `files` 符号锚点自己 Read）；② **不内联红绿步骤**（只点名「按 `test-driven-development` 实施」，过程在该 skill 里）；③ **不塞完整 report 模板**（子代理只按下面〔精简回报形状〕返回，主 session 自己映射）。

非 TDD task 仅受 ① 约束（已是〔精选来源〕通用规则），②③ 不适用。若该 task 在 plan.md 标了走 TDD，implementer 子代理按 `test-driven-development` 实施。

## 实施要求（写进 prompt）

- 实施完成后跑该 task 的 `verify` + **全量单元测试**（design.md 项目命令.单元测试），不只当前 task 新写的
- **verify 假绿检测（仅测试选择器型）**：若 `verify` 带测试选择器（`-t`/`--testNamePattern`/`-grep`/`-k` 等），跑后须确认**匹配到 ≥ 1 个测试**；0 匹配 = 选择器写错的假绿 → 报 `需补充信息`。非测试型 verify（`tsc --noEmit`、lint）只看退出码 0
- 既有单测挂了：默认当作回归，**修代码而非改测试**
- 极少数确信测试在测实现细节（而非行为）→ 报 完成但有顾虑 附理由（必须复核）
- **不跑** lint / typecheck / 集成测试（Stage 5 职责）
- **复用优先 + 最简实现**：写新代码前先 grep 相邻 / 共享模块，已有 helper 直接调用、不重复造；只写完成本 task `done` 所需的最简实现——不加可推导的冗余状态、不留死代码、不复制粘贴改两行。**仅限本 task 范围**——需泛化底层机制属架构级，留给 Stage 5，不在此越界重构
- **注释规则**：照 **`comment` skill（ai-flow 内置 `skills/comment/`，判据的单一权威源）**——注释只服务无本次 flow 上下文（不翻 `docs/feat-flows/`）的未来维护者；默认不写、只留代码表达不了的「缘由 / 否定 / 约定 / 边界」四类、命名/类型/结构能表达的不写、lint/路径规则已强制的不写；**自包含**禁指向 flow 临时产物（`Task N` / `U<k>` / `Phase X` / `见上文` / `design.md D-xx` / ADR 编号），要留就展开实质、不写指针；commit message 同此（`task-reports.md` 等 flow 内归档不受限）；改代码同步修 / 删失准的相邻注释
- **单元是耦合簇时**：见下节——簇内**逐 task commit、逐 task 跑 verify**，不是一坨做完只 commit/verify 一次
- **知识沉淀（测试通过后、返回前——你在代码里，故由你做）**：识别本 task 引入、命中「缘由 / 否定 / 约定 / 边界」4 类的知识（非显然选择含为何不选 X · 验证某方案不可行 · 不确定是否已记录的命名/架构/接口约定 · 依赖外部条件会静默失效），对每条调用 `optimize-claude-context` 的 `assess-candidate`，只把它保留的**幸存候选 + 路由（目标层 + 理由 + file:line）**纳入精简回报（其余由 skill 自理，不必回报）。跳过：调试试验 / 临时绕过 / 个人偏好

## 耦合簇执行（单元含多个 task 时）

一个 fresh subagent 在同一上下文里连续做完整簇（共享 decisions 并集 = 消漂移），但**不得牺牲 per-task 质量基建**：

- **逐 task commit**：簇内每个 task 各自一个 commit（不是一坨），保留回滚/审查粒度——簇内 task A 错了不必连累 task B。
- **逐 task 跑 verify**：簇内每个 task 各跑自己的 `verify`，保留 per-task 行为闭环。
- **越界检查升到「簇 `files` 并集」层**：簇内 task 间互相写对方文件属正常协作，单 task 越界检查在簇内失效；改为对比簇 `files` 并集，并**要求子代理回报「每个 task 实际碰了哪些文件」**供细粒度核对。
- 簇内每个 task 都各自落一份 task report（与独立 task 同格式）。

## 子代理的精简回报形状（写进 prompt）

子代理只回这几项，**不背完整 report 模板**：

状态（完成/完成但有顾虑/受阻/需补充信息）+ commit SHA + 改了哪些文件做了什么（一两句）+ verify 结果（含匹配到几个测试）+ 本 task 引入的新术语/模式（无则「无」）+ **知识沉淀：幸存的 context / ADR 候选及其 assess-candidate 路由（目标层 + 理由 + file:line；无则「无」）** + 顾虑或受阻原因（无则「无」）。

**单元是耦合簇时**：每个 task 各回一组（commit SHA + **该 task 实际碰了哪些文件** + verify 结果），供越界并集层核对。

收到回报之后怎么落盘、怎么评审 → `task-report-and-review.md`。
