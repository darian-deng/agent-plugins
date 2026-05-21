# Stage 5：质量门

> feat-flow 第 5/6 步 · [流程总览](../helper.md)
> 后续：Stage 6 知识沉淀（无 Gate）
> 当前 stage 目的：自动化验证（lint / typecheck / 测试）+ 3 轮互审，确保代码质量。**验证与审查合并在一个 stage**，避免传统拆分时的"修了一个又破另一个"套娃
>
> **元规则**：允许 commit，但仅限修复用——验证失败修复（`fix: resolve verification errors`）或审查接受修复（`fix: address review finding`）。

## 目标

确保 base_sha_code 之后的所有代码改动通过：
- 自动化检查（lint / typecheck / 单元测试 / 集成测试）
- 3 轮互审协议（reviewer ↔ author，最多 3 轮，分歧 escalate 开发者）

## 前置读取

- `docs/feat-flows/<flow_id>/design.md` — 项目命令、决策记录、AC
- `docs/feat-flows/<flow_id>/architecture.md`
- `.ai-flow/feat-flow/state/base_sha_code` — Stage 4 起点 SHA
- `docs/adr/` 相关 ADR（reviewer 引用用）

## Phase A：自动化检查

按 design.md 项目命令运行：
- 单元测试：`<design.md 项目命令.单元测试>`
- 集成测试（若有）：`<design.md 项目命令.集成测试>`
- Lint：`<design.md 项目命令.Lint>`
- Typecheck：`<design.md 项目命令.Typecheck>`

**失败处理**：
- 修代码（默认）
- 若是既有测试 break + 怀疑测试在测 implementation detail → 应用「既有测试破坏纪律」（见下）
- 修复后 `git add . && git commit -m "fix: resolve verification errors"`
- 重跑直到全过

### 既有测试破坏纪律

**默认假设**：本次改动是 regression，要修代码。

**例外**：若 author 认为既有测试在测 implementation detail 而非 behavior（违反 testability 原则），可提议改测试：
- 必须在 review.md「测试调整」section 明确列出：哪条测试、为什么是测了实现细节、新测试如何覆盖原意图
- 必须经 review subagent 复核（dispatch 时附"测试调整复核"任务）
- 复核通过才允许改测试

**绝对禁止**：通过修改测试 assert 让测试"通过"而不解释为什么。

## Phase B：代码审查（3 轮互审，硬上限）

### 轮 1：dispatch `feature-dev:code-reviewer` subagent

传入：
- `git diff $(cat .ai-flow/feat-flow/state/base_sha_code) HEAD`
- design.md 全量（含决策记录——已对齐决策不得再质疑）
- architecture.md
- 相关 ADR 路径列表
- **不传 plan.md**（避免审查被实施过程影响）

要求 reviewer：
- 每 issue 附 ≤5 行代码片段证据
- confidence ≥ 80（feature-dev:code-reviewer 自带过滤）
- **硬性 checklist**：
  1. 改动函数所在文件的相邻 ±20 行注释是否仍准确？（抓注释 drift）
  2. 跨 task 一致性：术语 / 命名是否一致？数据结构跨文件是否对齐？
  3. ADR 合规：本次代码改动是否违反既有 ADR？issue 必须引 ADR ID 作证据
  4. 删除的注释 ≥3 行：implementer 是否在 task report 写了理由？理由是否充分？

### 轮 1：主 session 按 receiving-code-review 纪律逐条处理

调用 `receiving-code-review` skill（或参照其纪律）。要点：
- **严禁** "You're absolutely right!" / "Great point!" / 任何 thanks 类表演性同意
- 每条先 VERIFY against codebase reality
- 三种特殊处置：
  - **YAGNI 检查**：reviewer 提"应该实现 X / 完善 Y" 类 → 先 grep 该功能是否真有调用方，无调用 → pushback "YAGNI"
  - **架构级冲突**：若 reviewer issue 挑战 design.md 已记录的决策（非 implementation 细节）→ **直接列入 review.md「待开发者决策（架构级）」，不进 3 轮循环**
  - **既有测试质疑**：reviewer 建议改测试 → 应用既有测试破坏纪律
- **处理顺序**：clarify 不清楚的 → blocking → simple fixes → complex fixes，每条修完单独跑测试
- accept → 修代码，commit `fix: address review finding`，记 review.md「已解决」
- pushback → review.md「分歧」记反证（≤5 行片段）

### 轮 2：SendMessage 同一 reviewer subagent

发送：已处理结果 + pushback 反证

reviewer 用 `git diff` 验证每个 accept 项的修复 + 重新评估 pushback 项 → 返回：验证通过 / 撤回 pushback / 仍坚持。

### 轮 3（仅当有剩余分歧）：SendMessage 发分歧项 + 双方完整立场

reviewer 给最终理由。主 agent 仍不认同 → review.md 标「需开发者决策 + 双方立场」。

**3 轮后任何剩余分歧 → 停下来等开发者，不再循环。**

### 自查前置 stage 问题（Stage 5 期间随时可能触发）

reviewer 或主 session 在 Stage 5 期间自查发现前置 stage 漏写 / 错了 → 走 `references/upstream-revision-protocol.md`：
- L1（推翻决策）→ 停下问开发者，建议 abort
- L2（漏写补全）→ 暂停 Stage 5，回更新前置文档，让用户确认，再回 Stage 5 继续
- L3（小修）→ inline 修文档，review.md 加注记

注：reviewer 挑战 design.md 已记录决策的「架构级冲突」处理（见前文轮 1）是本协议的特例。

### /clear 后的恢复

互审中途 /clear（reviewer subagent agent ID session-scoped 会丢失）→ 新 session 重启 Stage 5：

1. 已 commit 的修复 → reviewer 看到当前 HEAD 不会再 flag
2. review.md 累积的「已解决 / 已反驳 / 分歧」段保留——新 reviewer 启动时把现有 review.md 作为「上次审查的状态」一并传入
3. 用 fresh reviewer 接力（**不是同一个 reviewer subagent**），从轮 1 重审，依靠 review.md 的累积上下文避免重复劳动
4. 已记录的 pushback 反证 → 新 reviewer 直接评估反证是否成立，不重新提相同 issue

**前提**：每轮处理后必须**立即**写 review.md（accept / pushback / 分歧三类都即时落盘），不允许积累在主 session 内存。

### review.md 结构

```markdown
# 代码审查

## 审查范围
BASE_SHA_CODE: <SHA>

## 问题处理

### 已解决
- <问题描述>：<修复方式> — 证据：`<≤5 行片段>`

### 已反驳
- <问题描述>：<反证：≤5 行片段>

### 待开发者决策（架构级）
- <问题描述>：reviewer 立场 + author 立场

### 测试调整记录
- <如有> 改测试的位置 + 理由 + 复核者意见

## 结论
<总体评估>
```

## 完成条件

- 自动化检查全过（最后一个 commit 后跑一次确认）
- review.md 存在且完整
- 所有「已解决」类问题已修复 + commit
- 「待开发者决策」类问题由开发者拍板后已应用

## Signal

**触发条件**：本阶段「完成条件」全部满足，**或**用户明确表达本阶段已完成。
**动作**：用 Write 工具向 `.ai-flow/feat-flow/state/signal` 写入任意内容。
