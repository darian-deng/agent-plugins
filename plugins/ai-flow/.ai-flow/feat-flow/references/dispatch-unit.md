# 派发一个执行单元：预处理、prompt 拼装、实施要求

> **触发**：stage-4 主循环要 dispatch 下一个执行单元（1 个独立 task 或 1 个耦合簇）。**每个单元都从头走一遍本文件**。
> 读者是主 session。`<flow_root>` = 本文件所在目录的上一级。

## 模型分层（降本提速、质量不降）

- **实施子代理**：`model='sonnet'`（1M context）。依据：plan 已把 `decisions` / `verify` / `files` 喂到位，实施退化为机械执行 + TDD 红绿棘轮兜底，故执行侧可用更便宜的模型；它又是 token 大头（读文件 + 写码 + 跑全量测试 + 多轮红绿），降这里省得最多、提速最明显。该单元 plan 标了 `output_size: large` 或 `effort_hint: high`（截断防御 / 跨域多接驳 / 高风险隔离 / 非枚举型复杂度）时，在 dispatch prompt 里原文点出这个信号，提示实施子代理这个单元复杂度更高、需要更仔细——**这只是 prompt 里的自然语言提醒，不是技术层面的参数调节**（`Agent` 工具不支持按次覆盖 effort，effort 只能预置在 subagent 类型定义文件里，`general-purpose` 是内置类型改不了；本设计不为此引入自定义类型）。
- **评审子代理**：保持强——`model='opus'`，**绝不与实施侧同档**。依据：评审是让实施侧敢用更便宜模型的质量门（抓越界 / 假绿 / 注释 / spec 偏离），它只读 `git show` 的 diff、本身很便宜，降它省不了多少却拆掉整道安全网。

每个单元通过 `Agent` 工具 dispatch（`subagent_type='general-purpose'`）。**派完就结束回合等唤醒**，怎么等、回报怎么读、`/clear` 撞上在飞代理怎么办 → `subagent-lifecycle.md`。

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
- plan.md 路径（**仅供看前后 task 上下文，禁止跨 task 拿活**）。⛔ **同时写死「只按需读相关段、不许整篇 Read」**——给了路径它默认整篇读，而 plan.md 带着全部 task 的 `decisions` 切片可以有几十 KB，**读进去之后此后每一轮都重新计费**，其中绝大部分它一次都用不上（这也会把 stage-3 用 `output_size` 前置门压住的截断风险顶回来）。本 task 要用的字段已经整段拼在 prompt 里了，路径只是兜底
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

- 实施完成后跑该 task 的 `verify` + **本 task 直接影响到的包 / 目录的单元测试**——命令**原样取 design.md 项目命令表的「单元测试（限定范围）」那一行**，把范围填进去；⛔ **那一行写"无"时，退回跑不限范围的「单元测试」整条，不许自己现编 filter / 路径参数**（红线「不补 plan 没给的信息」管这里；而且 monorepo 里 `--filter <猜错的包名>` 零匹配时退出码仍是 0——跑了 0 个测试却报全绿，假绿检测只覆盖带测试选择器的 `verify`、抓不到这条）。**回报里要写明实际跑的那条命令和通过数**（见下方回报形状），不只写「全绿」。⛔ **不要下「整仓全量」的地板要求**：整仓全量超出前台单条命令的超时上限，唯一出路是丢后台，而子代理丢后台之后无事可做、只能结束回合——**结束回合 = 它被终止**，宿主随即给主 session 发一条 `completed`、正文是它最后那句「在等测试跑完」，读起来像还在跑（grill-flow 实测这个形态出现 8 次以上，最长空转 1 小时 07 分）。**整仓全量回归是 stage-5 环节 A 由主 session 跑的**，跑在全部 task 组装后的树上，一轮只跑一次
- **给长跑命令设超时**：优先用宿主 `Bash` 工具自带的 timeout 参数；用 shell 的 `timeout 900 …` 前先确认它存在（**macOS 默认没有 `timeout(1)`**，不确认就照抄会拿到 exit 127，最坏被当成测试失败去改代码）。**门禁命令只回摘要**（失败条目 + 末尾几十行），别贴整段输出——贴进来的此后每轮重新计费。等不到就报 `受阻`，第一句说清卡在哪、工作树里现在有什么
- **verify 假绿检测（仅测试选择器型）**：若 `verify` 带测试选择器（`-t`/`--testNamePattern`/`-grep`/`-k` 等），跑后须确认**匹配到 ≥ 1 个测试**；0 匹配 = 选择器写错的假绿 → 报 `需补充信息`。非测试型 verify（`tsc --noEmit`、lint）只看退出码 0
- 既有单测挂了：默认当作回归，**修代码而非改测试**
- 极少数确信测试在测实现细节（而非行为）→ 报 完成但有顾虑 附理由（必须复核）
- **不跑** lint / typecheck / 集成测试（Stage 5 职责）
- **复用优先 + 最简实现**：写新代码前先 grep 相邻 / 共享模块，已有 helper 直接调用、不重复造；只写完成本 task `done` 所需的最简实现——不加可推导的冗余状态、不留死代码、不复制粘贴改两行。**仅限本 task 范围**——需泛化底层机制属架构级，留给 Stage 5，不在此越界重构
- **注释规则**：照 **`comment` skill（ai-flow 内置 `skills/comment/`，判据的单一权威源）**——注释只服务无本次 flow 上下文（不翻 `docs/feat-flows/`）的未来维护者；默认不写、只留代码表达不了的「缘由 / 否定 / 约定 / 边界」四类、命名/类型/结构能表达的不写、lint/路径规则已强制的不写；**自包含**禁指向 flow 临时产物（`Task N` / `U<k>` / `Phase X` / `见上文` / `design.md D-xx` / ADR 编号），要留就展开实质、不写指针；commit message 同此（`task-reports.md` 等 flow 内归档不受限）；改代码同步修 / 删失准的相邻注释
- **单元是耦合簇时**：见下节——簇内**逐 task commit、逐 task 跑 verify**，不是一坨做完只 commit/verify 一次
- **知识沉淀（测试通过后、返回前——你在代码里，故由你做）**：识别本 task 引入、命中「缘由 / 否定 / 约定 / 边界」4 类的知识（非显然选择含为何不选 X · 验证某方案不可行 · 不确定是否已记录的命名/架构/接口约定 · 依赖外部条件会静默失效），对每条调用 `optimize-claude-context` 的 `assess-candidate`，只把它保留的**幸存候选 + 路由（目标层 + 理由 + file:line）**纳入精简回报（其余由 skill 自理，不必回报）。跳过：调试试验 / 临时绕过 / 个人偏好

## `[manual]` 项：上报判据与登记（写进 prompt + 主 session 登记）

**判据（写进 prompt）**：「本 task 的行为里，有哪些是**机器地板（`verify` / 单测 / typecheck / lint）验不了**的」——典型是触发原生能力或主进程运行时、鉴权与登录态流转、设备 I/O、跨端 / 跨平台真机行为、视觉与交互反馈（主题跟随、动画、焦点）。有就在回报里写一条「验什么」的一句话，没有就写「无」。

⛔ **漏报的代价是静默的**：空清单天然满足完成条件，于是全流程唯一的真机验证落点被整段跳过。

**主 session 登记（落盘，不能只活在对话里）**：回报里有 `[manual]` 项 → 写进该 task 的 task report `### 待人工验证` 字段（`- <验什么>`，见 `task-report-and-review.md` 模板）。stage-5 环节 C 从这里 + design.md 里 stage-1 已标的 `[manual]` AC **两个来源**汇总成清单，交开发者逐条真机验、全部收口才允许 squash。

## 耦合簇执行（单元含多个 task 时）

一个 fresh subagent 在同一上下文里连续做完整簇（共享 decisions 并集 = 消漂移），但**不得牺牲 per-task 质量基建**：

- **逐 task commit**：簇内每个 task 各自一个 commit（不是一坨），保留回滚/审查粒度——簇内 task A 错了不必连累 task B。
- **逐 task 跑 verify**：簇内每个 task 各跑自己的 `verify`，保留 per-task 行为闭环。
- **越界检查升到「簇 `files` 并集」层**：簇内 task 间互相写对方文件属正常协作，单 task 越界检查在簇内失效；改为对比簇 `files` 并集，并**要求子代理回报「每个 task 实际碰了哪些文件」**供细粒度核对。
- 簇内每个 task 都各自落一份 task report（与独立 task 同格式）。

## 子代理的精简回报形状（写进 prompt）

子代理只回这几项，**不背完整 report 模板**：

⛔ **首行写死格式：`impl-done: <commit sha>`**（耦合簇：该簇最后一个 task 的 sha）。**没做完就不许写这一行**——改为首行 `blocked: <一句话卡在哪>`。这是主 session 唯一不需要理解正文就能判「这一票到底交付没交付」的判据（宿主对「干完了」和「停下了」发的是同一种 `completed` 通知），所以它必须在固定位置、固定格式。

首行之后：状态（完成/完成但有顾虑/受阻/需补充信息）+ 改了哪些文件做了什么（一两句）+ verify 结果（含匹配到几个测试）+ **范围测试：`<实际跑的那条命令>` → 通过 N 个**（取 design.md「单元测试（限定范围）」那行；该行为"无"时写明改跑了不限范围的整条 + 通过数。⚠️ N 是 0 就是没验到东西，按 `需补充信息` escalate、别当全绿）+ 本 task 引入的新术语/模式（无则「无」）+ **知识沉淀：幸存的 context / ADR 候选及其 assess-candidate 路由（目标层 + 理由 + file:line；无则「无」）** + **`[manual]` 项：本 task 碰到的、机器地板验不了因而需要开发者真机验的行为**（判据与登记见下节；无则写「无」）+ 顾虑或受阻原因（无则「无」）。

**单元是耦合簇时**：每个 task 各回一组（commit SHA + **该 task 实际碰了哪些文件** + verify 结果），供越界并集层核对。

收到回报之后怎么落盘、怎么评审 → `task-report-and-review.md`。
