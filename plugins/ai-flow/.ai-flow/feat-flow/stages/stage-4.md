# Stage 4：代码实施

> feat-flow 第 4/6 步 · [流程总览](../helper.md)
> 当前 stage 目的：按 plan.md 逐 task 实施，每 task 一个 commit，全部由子代理完成

## 目标

调用 `subagent-driven-development`（下称 SDD）编排执行 plan.md：每个 task 由 fresh 子代理实施 + 两段评审（规格、质量）。**主 session 只做调度**——读 plan.md / task-reports.md、构造 dispatch prompt、记录结果；代码的读写和测试全部发生在子代理里，禁止主 session 直接写代码。

## 前置读取

- `docs/feat-flows/<flow_id>/plan.md` — 主 session 只读它拿 task 列表

design.md / architecture.md **不在主 session 读取**——它们作为路径写进子代理 prompt、由子代理按需自取。主 session 提前读会污染 context，并诱导在主 session 内联写代码。

## 入场动作

**先判首次进入还是 /clear 重入**：

```bash
# 读当前 flow_id（active.json 永远存在于此刻）
CURRENT_FLOW_ID=$(python3 -c "import json; print(json.load(open('.ai-flow/feat-flow/state/active.json'))['flow_id'])")
# 读 base_sha_code 第一行：新格式存 flow_id，旧格式存 SHA——两者都不等于 CURRENT_FLOW_ID 时视为首次进入
FILE_FLOW_ID=$(head -1 .ai-flow/feat-flow/state/base_sha_code 2>/dev/null || echo "NONE")
```

- **`FILE_FLOW_ID == CURRENT_FLOW_ID`，或 plan.md 已有 `[x]`** → 这是 /clear 重入：**跳过下面 Step 1**（绝不重跑——覆写 base_sha_code 会污染 Stage 5 的 diff 基准）。改为：读 task-reports.md 重建待沉淀术语 → 从第一个未 `[x]` 的 task 续跑主循环。其中遇到**已 commit 但无 `**审查**` 行的 task → 一律重跑两段评审**（无法区分「没审」还是「审了没回填」，重跑安全）。Step 0 的分支复核仍要做。
- **`FILE_FLOW_ID != CURRENT_FLOW_ID`（含文件不存在）且 plan.md 无 `[x]`** → 首次进入，按 Step 0 → 3 顺序走。若文件已存在但 flow_id 不匹配，输出提示：`⚠️ base_sha_code 属于 flow <FILE_FLOW_ID>，当前 flow 为 <CURRENT_FLOW_ID>，视为首次进入并覆写`。

**Step 0：分支 + 工作树预检（任何 commit 之前）**

```sh
git branch --show-current
git status --porcelain
```

- **分支**：当前在 `main` / `master`（或仓库默认分支）→ **停下，要求开发者先 checkout 一个需求分支再继续**。绝不在 main 上落任何一笔 commit（连下面起点的 docs commit 也不行）。
- **工作树**：输出非空且含**代码文件**改动 → 停下问开发者：「检测到工作树有未提交的代码改动，是上次 task 执行中途崩溃的残留，还是预期的中间状态？请确认如何处理。」（仅 docs/feat-flows/ 改动属正常）

**Step 1：起点 commit + 记录 base_sha_code**

```sh
git add docs/feat-flows/<flow_id>/
git commit -m "docs: <feature> stage1-3 outputs"
# 写两行：第一行 flow_id（用于跨 flow 污染检测），第二行 SHA（供 Stage 5/6 作 diff 起点）
printf "%s\n%s\n" \
  "$(python3 -c "import json; print(json.load(open('.ai-flow/feat-flow/state/active.json'))['flow_id'])")" \
  "$(git rev-parse HEAD)" \
  > .ai-flow/feat-flow/state/base_sha_code
```

把 Stage 1-3 累积的 docs 一次性提交；`base_sha_code` 供 Stage 5/6 当 diff 起点（只看代码、不看 docs）。第一行的 `flow_id` 防止多 flow 顺序运行时读到上个 flow 的基准 SHA。

**Step 2：初始化 task-reports.md**

```sh
touch docs/feat-flows/<flow_id>/task-reports.md
```

每 task 完成后主 session 把 task report 追加进来——这是跨 /clear 保留 task 级元信息的唯一手段。

**Step 3：定位 ADR 目录**

按 `references/adr-scan.md` 定位本仓库的 ADR 目录 / 读索引，**知道有哪些 ADR（标题 + 状态）** 即可。**不在此处一次性选定**——每个 task 涉及的模块不同、相关 ADR 也不同，相关性筛选放到每个 task 的 prompt 构造时做（见下）。

## 主循环：用 SDD 逐 task 执行

调用 `subagent-driven-development` 执行 `docs/feat-flows/<flow_id>/plan.md`。每个 task 通过 `Agent` 工具 dispatch（`subagent_type='general-purpose'`）。

**开跑前**：解析 plan.md 的 task 列表——解析到 0 个 task → 停下问开发者（疑似 plan.md 损坏或 Stage 3 未完成）。

**每个 task dispatch 前**：`git branch --show-current` 复核仍不在 main/master（防运行中途被切回 main，导致后续 commit 落到 main）。

**抑制 SDD 的越界默认行为**（feat-flow 接管这些，不让 SDD 冲出 stage-4 边界）：
- **不建 worktree**——feat-flow 在当前工作树跑（引擎靠 `cwd/.ai-flow` 定位状态，worktree 会让 cwd 漂走、base_sha 失效）
- **不调用 `finishing-a-development-branch`**——merge / PR 收尾归 Stage 6 + 开发者
- **不跑 SDD 的「整体 final reviewer」**——整体审查是 Stage 5 的职责（`base_sha..HEAD` + 组装级双视角审查），在此重复且可能给出打架结论
- **continuous execution 的边界**：SDD 默认「task 间不停顿、不向开发者要确认」——这指**不做「要不要继续」式的人类 check-in**，**不等于**省略主 session 每 task 之间的落盘 / 待沉淀术语重组 / 审查行回填。这几步是必做的调度动作，不算 check-in，不要为「连续执行」跳过

**子代理走 TDD**：若该 task 在 plan.md 标了走 TDD，implementer 子代理按 `test-driven-development` 实施。

**状态报告用中文**：implementer 用「完成 / 完成但有顾虑 / 受阻 / 需补充信息」四种状态报告（对应 SDD 的 DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT）。

**每个 task 的 implementer prompt = 精选来源**（给指针，子代理按需读，不批量加载）：
- 当前 task 完整文本（粘贴 plan.md 对应段）
- `docs/feat-flows/<flow_id>/design.md`、`architecture.md` 路径
- `docs/feat-flows/<flow_id>/plan.md`（**仅供看前后 task 上下文，禁止跨 task 拿活**）
- **该 task 相关的 ADR**：拿本 task 涉及的文件 / 模块，对照 Step 3 拿到的 ADR 索引（标题 + 状态）做相关性匹配，挑出相关 ADR 的**路径**（≤5 条）传给 implementer，由 implementer 按需读全文；主 session 自己不读 ADR 全文。每 task 各自选，不复用一份全局清单
- **待沉淀术语**：前置 task 累积的「新术语或模式」（主 session 每次 dispatch 前重新组装，见下文）
- 提示：用 `git log` / `git show <commit>` 看前置 task 已实现的细节

**聚焦约束**（写进 prompt）：专注当前 task，不探索范围外的代码或议题；优先按 task 里的 `file:line` 直读，不读整文件；用 `git show` 看前置 diff，不读整文件。

**实施要求**：
- 实施完成后跑**全量单元测试**（design.md 项目命令.单元测试），不只当前 task 新写的
- 既有单测挂了：默认当作回归，**修代码而非改测试**
- 极少数确信测试在测实现细节（而非行为）→ 报 完成但有顾虑 附理由（必须复核）
- **不跑** lint / typecheck / 集成测试（Stage 5 职责）
- 单处一次性删除连续注释 ≥3 行，必须在 task report 写理由

**两段评审**（SDD 自带，feat-flow 额外要求落盘）：规格审查 → 质量审查，每 task 各自独立跑、不跨 task 合并；两段一结束**立即**把结论回填到 task-reports.md 该 task 的 `**审查**` 行，不得延后。主 session dispatch 下一个 task 前，先确认上一 task 已有 `**审查**` 行（没有则先补跑评审再回填）。

**知识沉淀**（task 到达 完成 / 完成但有顾虑 终态后做一次整体回顾——不是实施中随手记；完成但有顾虑 也要回顾）：

识别命中以下任一类的决策，对每条调用 `optimize-claude-context` 的 `assess-candidate` 拿到「目标层路由」，记进 task report 对应字段（assess-candidate 只返回路由决策，怎么记由本 stage 决定）：
1. **缘由类**：做了非显然选择、或绕过了更自然的做法（含「为什么不选 X」的权衡）
2. **否定类**：验证了某方案不可行（含验证过程和失败原因）
3. **约定类**：用了不确定是否已记录的命名规范 / 架构惯例 / 接口契约
4. **边界类**：实现依赖外部条件，条件变化会静默失效（版本、环境、隐式顺序假设）

跳过（不算候选）：调试中间试验、临时绕过方案（尚未确认提交）、个人工作偏好。

## task report 格式（每 task 完成后主 session 立即落盘）

implementer 报 完成 / 完成但有顾虑 后，主 session **立即**把下面这段追加到 `task-reports.md`。无内容的字段填「无」：

```markdown
## Task N: <task 标题>

**状态**: 完成 | 完成但有顾虑
**Commit**: <commit-sha>
**日期**: YYYY-MM-DD
**审查**: 规格 PASS|FAIL，质量 PASS|FAIL

### 新增注释
加缘由注释的位置（文件头 / 块 / 行内）+ 注释了什么

### 新术语或模式
本 task 引入的术语 / 命名规范（如 "LRUEvictionPolicy"）——后续 task 靠它避免命名漂移

### context 候选
注释承载不了、该进 context 层的知识；每条带 assess-candidate 给的目标层（rules/<domain>.md | CLAUDE.md | skill）

### ADR 候选
跨文件、有权衡的架构决策——Stage 6 评 ADR

### 注释删除
单处删除连续注释 ≥3 行的位置 + 理由

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

**需补充信息**（严于 SDD 默认）：
1. 查答案是否在三份 docs / 该 task 相关 ADR 里
2. **在** → 改 prompt 加更明确指向，重 dispatch 一次；仍 需补充信息 → 停下问开发者
3. **不在** → 直接停下问开发者，**不许凭空补答案**（主 session 的信息源就是这些 docs；子代理读了还问 = 文档真缺信息 = 主 session 也编不出）

**受阻**：按 SDD 规则尝试一次（补 context / 换更强模型 / 拆 task / plan 错则上报开发者）；同一 task 第 2 次 受阻 → 停下问开发者。

**重 dispatch 前**（受阻 / 需补充信息 重试）：先确认工作树状态——上次尝试若留下未提交改动，先决定 reset 还是保留，并把这个决定写进重 dispatch 的 prompt（否则会与 Step 0「工作树非空」预检在重入时叠加误报）。

**自查前置 stage 问题**（运行时随时可能触发）：implementer 或主 session 发现前置 stage 漏 / 错 → 走 `references/revision-protocol.md` 入口 B（已含「L2 改了上游后评估已完成 task 是否需 fix-up task」的兜底）。**L1 / L2 必须停下等开发者**——stage-4 无 Gate、又自动连跑，更要主动停，不能借「连续执行」冲过去；**L3** 才 inline 修 + 在 task report 的「前置修订」字段注记。

## 收口（全部 task 完成后）

最后一个 task 的审查行回填后：**不进 SDD 的收尾流程**（不跑 final reviewer、不调 `finishing-a-development-branch`）→ 直接核对下面「完成条件」→ 写 signal。整体质量审查交给 Stage 5。

## 输出规格

- plan.md 所有 task 标 `[x]`，每 task 一个 commit
- `.ai-flow/feat-flow/state/base_sha_code` 存在
- `task-reports.md` 累积全部 task report（Stage 6 从此读 ADR 候选 / 新术语或模式 / context 候选）

## 完成条件

- plan.md 所有 task 标 `[x]`
- `base_sha_code` 存在
- 全部 task 都有对应 commit
- `task-reports.md` 含全部 task report（每 task 一段，含 `**审查**` 行）

## Signal

**触发条件**：本阶段「完成条件」全部满足，**或**开发者明确表达本阶段已完成。
**动作**：用 Write 工具向 `.ai-flow/feat-flow/state/signal` 写入 `done`（引擎接受此关键词，自动推进）。
