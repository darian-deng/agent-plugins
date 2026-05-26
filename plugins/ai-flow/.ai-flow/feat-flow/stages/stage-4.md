# Stage 4：代码实施

> feat-flow 第 4/6 步 · [流程总览](../helper.md)
> 后续：Stage 5 质量门（Gate）
> 当前 stage 目的：按 plan.md 逐 task 实施，每 task 一 commit，全部由 subagent 完成
>
> **元规则**：起点 commit 一次 docs（Stage 1-3 产物）；每 task 一个 commit。除此之外不主动 commit。

## 目标

直接 invoke `superpowers:subagent-driven-development` skill 执行 plan.md。主 session 是调度者，不直接写代码。

## 前置读取

- `docs/feat-flows/<flow_id>/design.md`
- `docs/feat-flows/<flow_id>/architecture.md`
- `docs/feat-flows/<flow_id>/plan.md`

主 session 必须读完三份文档再进入 SDD——因为后续 dispatch 每个 implementer 时要主动构造 Curated Sources。

## 入场动作

**Step 0：工作树状态检查（防 mid-task crash 残留）**

```sh
git status --porcelain
```

- 输出为空（仅含 docs/feat-flows/ 改动） → 正常，进 Step 1
- 输出非空且含代码文件改动 → **停下问开发者**：「检测到工作树有未 commit 改动。这是上次 Stage 4 mid-task crash 残留吗？还是预期的中间状态？请确认如何处理。」

**Step 1：Stage 4 起点 commit + 记录 BASE_SHA_CODE**

```sh
git add docs/feat-flows/<flow_id>/
git commit -m "docs: <feature> stage1-3 outputs"
git rev-parse HEAD > .ai-flow/feat-flow/state/base_sha_code
```

这个 commit 把 stage 1-3 累积的 docs 一次性提交。`base_sha_code` 文件供 Stage 5 用作 diff 起点（只看代码改动，不看 docs）。

**Step 2：ADR scan**

`ls docs/adr/` + 筛与本 flow 涉及模块相关的 ADR 路径列表，作为后续 implementer Context 注入。

**Step 3：初始化 task-reports.md**

```sh
touch docs/feat-flows/<flow_id>/task-reports.md
```

后续每个 task 完成后，主 session 把该 task 的 task report 追加到此文件——这是跨 /clear 保留 task 级元信息的唯一手段（详见下文「task-reports.md 持久化」）。

## 主循环：调用 SDD

调用 `superpowers:subagent-driven-development` 执行 `docs/feat-flows/<flow_id>/plan.md`。

**对 SDD 默认 implementer-prompt 的修改**（基于我们的三工件拓扑）：

每个 task 的 implementer prompt 改为含以下 Curated Sources（subagent 按需读，不批量加载）：

- 本 task 完整文本（paste-in plan.md 对应段）
- `docs/feat-flows/<flow_id>/design.md`
- `docs/feat-flows/<flow_id>/architecture.md`
- `docs/feat-flows/<flow_id>/plan.md`（**仅前后 task 上下文用，禁止跨 task 拿活**）
- 相关 ADR 路径列表（来自 Step 1）
- **Pending vocabulary**：前置 task 累积的 NEW_TERMS_OR_PATTERNS（主 session 每次 dispatch 重新组装）
- 提示：`git log` / `git show <commit>` 看前置 task 已实现细节

**Focus 约束**（写进 implementer prompt）：
- 专注本 task，不探索本 task 范围外的代码或议题
- 优先按 task 描述里的 file:line 直读，不读整个文件
- 用 git show 看前置 task diff，不读整个文件

**Review 执行约束**（写进主 session 调度逻辑）：
- spec compliance review 和 code quality review 必须每个 task 独立执行
- 禁止跨 task 批量合并 quality review，即使相邻 task 逻辑相似
- 每个 task 的 review 结论必须在 task-reports.md 对应 task 段落里落盘（格式见下文，新增 `**Review**` 行）
- 主 session 在 dispatch 下一个 task 前，先确认 task-reports.md 中上一 task 有 `**Review**` 行 → 有则继续，无则先补写

**本 task 实施要求**：
- 走 TDD（若 plan task 标注要走）
- 实施完成后跑**全量单元测试**（design.md 项目命令.单元测试），不仅本 task 新写的测试
- 既有单测 break：默认假设是 regression，修代码而非改测试
- 极少数情况认为测试在测 implementation detail → DONE_WITH_CONCERNS 附建议改测试的理由（必须复核）
- **不跑** lint / typecheck / 集成测试（Stage 5 职责）
- **知识沉淀优先级**（每遇到 non-obvious 决策时必须判断）：
  - **第一步：先用代码注释**——两种形式：
    - File header 注释：整个文件的设计意图 / 为什么这样组织
    - Block/inline 注释：具体逻辑的 why、非显而易见的约束、绕过特定 bug 的原因
  - **只有满足以下任意一条，才往后走**（注释无法承载的判断标准）：
    1. 超出当前文件：其他文件的实施者也需要遵守这条约束
    2. 未来新代码必须遵循：对所有未来代码的要求，不只是解释现有代码
    3. 有被放弃的替代方案：存在架构 trade-off，需要记录「为什么不选 X」
    4. 可复用的多步流程：需要反复执行的操作序列，不是一处判断
  - **满足上述条件后，按层路由**（多条可同时满足，各条路由独立记录）：
    - 条件 1/2（超出文件 / 未来新代码必须遵循）→ 记入 `CONTEXT_CANDIDATES`（rules / CLAUDE.md / skill 类）
    - 条件 3（有被放弃的替代方案）→ 记入 `ADR_CANDIDATES`，不记 CONTEXT_CANDIDATES
    - 条件 4（可复用多步流程）→ 记入 `CONTEXT_CANDIDATES`（skill 类）
    - 同时满足条件 3 和其他条件时：ADR_CANDIDATES 和 CONTEXT_CANDIDATES 均记
- 删注释 ≥3 行必须在 task report 写理由

**task report 额外字段**（在 SDD 默认 DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT 基础上）：
- `INLINE_COMMENTS_ADDED`：在哪些代码位置加了 WHY 注释（file header / block / inline）
- `NEW_TERMS_OR_PATTERNS`：本 task 引入的**术语/命名规范**候选（如 "LRUEvictionPolicy"），建议进 rules
- `CONTEXT_CANDIDATES`：通过「注释无法承载」判断后，需进入项目 context 层的候选，按目标层标注：
  - `rules/<domain>.md`：当前 package 适用的约束
  - `CLAUDE.md`：全局行为规范
  - `skill`：可复用操作流程
  - （ADR 类仍记入 `ADR_CANDIDATES`，不在此字段）
- `ADR_CANDIDATES`：跨文件性质、有 trade-off 的架构决策候选（建议 Stage 6 评 ADR）
- `COMMENT_DELETIONS`：删除注释 ≥3 行的位置 + 理由
- `UPSTREAM_REVISION`（如适用）：本 task 期间自查发现前置 stage 问题——按 `references/upstream-revision-protocol.md` 标 L1/L2/L3 + 描述 + 处理

## task-reports.md 持久化（每 task 完成后必做）

implementer subagent 返回 DONE / DONE_WITH_CONCERNS 后，**主 session 必须立即**把该 task report 追加到 `docs/feat-flows/<flow_id>/task-reports.md`。

格式：

```markdown
## Task N: <task title>

**Status**: DONE | DONE_WITH_CONCERNS
**Commit**: <commit-sha>
**Date**: YYYY-MM-DD
**Review**: spec PASS | FAIL，quality PASS | FAIL

### INLINE_COMMENTS_ADDED
（位置列表：file header / block / inline，说明注释了什么）

### NEW_TERMS_OR_PATTERNS
（术语/命名规范候选，每条含建议层：rules/<domain>.md 或 CLAUDE.md）

### CONTEXT_CANDIDATES
（注释无法承载的知识，按目标层标注；如无，填"无"）
- `rules/<domain>.md`：
- `CLAUDE.md`：
- `skill`：

### ADR_CANDIDATES
（跨文件架构决策候选，每条含 trade-off 理由）

### COMMENT_DELETIONS
（删除位置 + 理由）

### UPSTREAM_REVISION
（如有：L?, 描述, 处理）

### Concerns
（如 DONE_WITH_CONCERNS 时填）

---
```

**为什么必须落盘**：
- `NEW_TERMS_OR_PATTERNS` / `ADR_CANDIDATES` 等是后续 task 和 Stage 6 的输入。task report 在主 session 内存里，/clear 后会丢——必须落盘才能跨 /clear 存活
- Stage 4 入场重建 Pending vocabulary 时从 `task-reports.md` 读，不依赖主 session 对话历史

## NEEDS_CONTEXT 处理（严于 SDD 默认）

implementer 报 NEEDS_CONTEXT 时主 session：

1. 检查问题答案是否在三份 docs / 相关 ADR 列表里
2. **在** → 改 implementer prompt 加更明确指向，重 dispatch 一次。仍 NEEDS_CONTEXT → 停下问开发者
3. **不在** → 直接停下问开发者，**不允许凭空补答案**

理由：主 session 的信息源就是这些 docs。subagent 读了还问 = 文档真缺信息 = 主 session 也编不出。

## BLOCKED 处理

按 SDD 规则尝试一次（补 context / 换模型 / 拆 task / plan 错 → escalate）。第 2 次同一 task BLOCKED → 停下问开发者。

## Pending vocabulary 注入（每次 dispatch 前）

主 session 在 dispatch 第 N 个 task 时：

1. 读 `docs/feat-flows/<flow_id>/task-reports.md`（**从文件读，不依赖对话历史**——确保 /clear 后仍能重建）
2. 合并所有已完成 task 的 `NEW_TERMS_OR_PATTERNS` 段
3. 作为 Curated Sources 的「Pending vocabulary（未正式入 rules）」注入下一个 implementer

这样后续 task 能看到前面 task 沉淀的新术语，避免命名漂移。

## 自查前置 stage 问题（运行时随时可能触发）

implementer 或主 session 在 Stage 4 期间自查发现前置 stage 漏写 / 错了 → 走 `references/upstream-revision-protocol.md`：
- L1（推翻决策） / L2（漏写补全） → 停下问开发者
- L3（小修） → inline 修文档，task report 加 `UPSTREAM_REVISION` 注记
- L2 修 design.md / architecture.md 后 → 评估已完成 task 是否需要 fix-up task（追加到 plan.md 末尾）

## 输出规格

- plan.md 中所有 task 标 `[x]`
- 每 task 对应一个 commit
- `.ai-flow/feat-flow/state/base_sha_code` 文件存在
- `docs/feat-flows/<flow_id>/task-reports.md` 累积所有 task report（**落盘文件，Stage 6 从此读 ADR_CANDIDATES / NEW_TERMS_OR_PATTERNS / CONTEXT_CANDIDATES**）

## 完成条件

- plan.md 所有 task 标 `[x]`
- `base_sha_code` 文件存在
- 全部 task 都有对应 commit
- `task-reports.md` 含全部 task report（每条 task 一段）
- SDD final reviewer pass（SDD 自带最后审查）

## Signal

**触发条件**：本阶段「完成条件」全部满足，**或**用户明确表达本阶段已完成。
**动作**：用 Write 工具向 `.ai-flow/feat-flow/state/signal` 写入任意内容。
